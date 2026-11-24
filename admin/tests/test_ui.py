from pathlib import Path
import sys
import unittest
import tkinter as tk
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core
import main
import ui


def session(i, folder='', port=22):
    return {'id':str(i), 'name':f'장비{i:04}', 'host':f'192.0.2.{i%255}', 'protocol':'ssh', 'port':port, 'folder':folder}


class ViewTests(unittest.TestCase):
    def test_dynamic_import_columns(self):
        self.assertEqual(ui.import_columns(0,False),'열 순서 (4열): 이름 → 주소 → 프로토콜 → 포트')
        self.assertIn('21열',ui.import_columns(16,True))
        with self.assertRaises(ValueError): ui.import_columns(17,False)

    def test_hidden_paste_input_and_replace_lifecycle(self):
        root=tk.Tk(); root.withdraw(); self.addCleanup(root.destroy)
        app=main.App.__new__(main.App); app.root=root; app.pending=None
        app.preview=Mock(); app.catalog=core.validate_catalog({'version':1,'sessions':[session(1)]}); app.folder=ui.ALL; app.commit=Mock(); app.refresh=Mock(); app.history_notice=''; app.status=Mock()
        original=main.tk.Toplevel
        def descendants(widget):
            for child in widget.winfo_children():
                yield child
                yield from descendants(child)
        def make_window(parent):
            win=original(parent); win.withdraw()
            def exercise():
                widgets=list(descendants(win)); editor=next(w for w in widgets if isinstance(w,tk.Text))
                buttons={w.cget('text'):w for w in widgets if isinstance(w,main.ttk.Button)}
                replace=buttons['목록 덮어쓰기']; clear=buttons['비우기']
                self.assertEqual(str(replace['state']),'disabled')
                editor.insert('1.0','이름\t주소\t프로토콜\t포트\nR1\t192.0.2.1\tssh\t22')
                root.update(); self.assertEqual(str(replace['state']),'normal')
                buttons['폴더 없음'].invoke()
                clear.invoke(); root.update(); self.assertEqual(str(replace['state']),'disabled')
                editor.insert('1.0','R1\t192.0.2.1\tssh\t22'); root.update()
                checks=[w for w in widgets if isinstance(w,main.ttk.Checkbutton) and w.cget('text')=='첫 행은 제목']; checks[0].invoke()
                replace.invoke(); self.assertFalse(win.winfo_exists()); app.commit.assert_called_once(); app.preview.assert_not_called()
            win.wait_window=exercise
            return win
        with patch.object(main.tk,'Toplevel',side_effect=make_window): app.paste()

    def test_hidden_paste_errors_preserve_input_and_clipboard_is_explicit(self):
        root=tk.Tk(); root.withdraw(); self.addCleanup(root.destroy)
        app=main.App.__new__(main.App); app.root=root; app.pending=None; app.preview=Mock(); app.catalog=core.validate_catalog({'version':1,'sessions':[]}); app.commit=Mock()
        original=main.tk.Toplevel
        def descendants(widget):
            for child in widget.winfo_children():
                yield child
                yield from descendants(child)
        def make_window(parent):
            win=original(parent); win.withdraw(); win.clipboard_get=Mock()
            def exercise():
                widgets=list(descendants(win)); editor=next(w for w in widgets if isinstance(w,tk.Text))
                buttons={w.cget('text'):w for w in widgets if isinstance(w,main.ttk.Button)}
                error=next(w for w in widgets if isinstance(w,main.ttk.Label) and str(w.cget('foreground'))=='#a12622')
                def error_text(): return root.getvar(error.cget('textvariable'))
                win.clipboard_get.assert_not_called()
                editor.insert('1.0','잘못된 행'); root.update(); buttons['목록 덮어쓰기'].invoke()
                self.assertTrue(error_text()); self.assertEqual(editor.get('1.0','end-1c'),'잘못된 행'); app.preview.assert_not_called()
                editor.insert('end',' 수정'); root.update(); self.assertEqual(error_text(),'')
                win.clipboard_get.return_value=''; buttons['클립보드 붙여넣기'].invoke(); self.assertIn('텍스트가 없습니다',error_text())
                win.clipboard_get.return_value='abc';
                with patch.object(core,'MAX_BYTES',1): buttons['클립보드 붙여넣기'].invoke()
                self.assertIn('20 MiB',error_text()); self.assertEqual(editor.get('1.0','end-1c'),'잘못된 행 수정')
                win.clipboard_get.side_effect=tk.TclError('unavailable'); buttons['클립보드 붙여넣기'].invoke(); self.assertIn('읽을 수 없습니다',error_text())
                win.destroy()
            win.wait_window=exercise
            return win
        with patch.object(main.tk,'Toplevel',side_effect=make_window): app.paste()

    def test_folder_special_names_and_nested_empty_folders(self):
        rows=[session(1),session(2,'전체'),session(3,'전체/하위'),session(4,'미분류')]
        self.assertEqual([s['id'] for s in ui.list_page(rows,folder=ui.ALL)['rows']],['1','2','3','4'])
        self.assertEqual([s['id'] for s in ui.list_page(rows,folder=ui.UNFILED)['rows']],['1'])
        self.assertEqual([s['id'] for s in ui.list_page(rows,folder='전체')['rows']],['2','3'])
        self.assertEqual([s['id'] for s in ui.list_page(rows,folder='미분류')['rows']],['4'])
        self.assertIn('빈/하위',ui.folder_paths(['빈/하위'],rows))
        self.assertIn('빈',ui.folder_paths(['빈/하위'],rows))

    def test_search_sort_and_paging_at_scale(self):
        rows=[session(i,'본사' if i%2 else '본사/서버',5000-i) for i in range(5000)]
        result=ui.list_page(rows,folder='본사',sort='port',page=1)
        self.assertEqual((result['total'],result['first'],result['last'],result['pages']),(5000,201,400,25))
        self.assertEqual(result['rows'][0]['port'],201)
        self.assertEqual(ui.list_page(rows,query='장비0007')['rows'][0]['id'],'7')
        self.assertEqual(ui.list_page(rows,query='not found')['first'],0)
        self.assertEqual(ui.list_page(rows,page=100)['page'],24)
        self.assertEqual(ui.list_page(rows,sort='port',descending=True)['rows'][0]['port'],5000)

    def test_import_resolution_and_final_conflict(self):
        base=core.validate_catalog({'version':1,'sessions':[session(1),session(2)],'folders':['빈']})
        rows=[dict(session(1),name='one'),dict(session(1),name='two')]
        plan=core.plan_merge(base,rows)
        counts,unresolved=ui.import_summary(plan,{})
        self.assertEqual((counts['확인필요'],unresolved),(1,1))
        self.assertEqual(ui.import_summary(plan,{2:'1'})[1],0)
        with self.assertRaises(core.ValidationError): core.apply_plan(base,plan,{2:'1'})
        result=core.apply_plan(base,plan,{2:'skip'})
        self.assertEqual({s['id'] for s in result['sessions']},{'1','2'})
        self.assertIn('빈',result['folders'])

    def test_shortcut_blocks_modal_and_guard_denials(self):
        app=main.App.__new__(main.App); app.root=Mock(); action=Mock()
        app.root.grab_current.return_value=object()
        self.assertEqual(app.shortcut(None,action),'break'); action.assert_not_called()
        app.root.grab_current.return_value=None
        app.shortcut(None,action); action.assert_called_once()
        app.pending={'items':[]}; app.local_save_failed=False; app.dirty=False
        with patch.object(main.messagebox,'askyesno',return_value=False): self.assertFalse(app.guard())
        app.pending=None; app.local_save_failed=True
        with patch.object(main.messagebox,'askyesno',return_value=False): self.assertFalse(app.guard())
        app.local_save_failed=False; app.dirty=True
        with patch.object(main.messagebox,'askyesno',return_value=False): self.assertFalse(app.guard())

    def test_refresh_retains_selection_focus_and_scroll(self):
        app=main.App.__new__(main.App)
        app.catalog={'folders':[], 'sessions':[session(1),session(2)]}
        app.folder=ui.ALL; app.sort='name'; app.descending=False; app.page=0
        app.dirty=False; app.local_save_failed=False; app.source=None
        app.refresh_folders=Mock(); app.selection_changed=Mock()
        app.tree=Mock(); app.tree.selection.return_value=('2',); app.tree.focus.return_value='2'
        app.tree.yview.return_value=(0.4,1); app.tree.xview.return_value=(0.2,1)
        app.tree.get_children.return_value=('1','2')
        app.query=Mock(); app.query.get.return_value=''
        app.prev_button=Mock(); app.next_button=Mock(); app.status=Mock(); app.state_label=Mock(); app.pathlabel=Mock()
        app.refresh()
        app.tree.selection_set.assert_called_once_with(['2'])
        app.tree.focus.assert_called_with('2')
        app.tree.yview_moveto.assert_called_once_with(0.4); app.tree.xview_moveto.assert_called_once_with(0.2)
        app.prev_button.config.assert_called_with(state='disabled'); app.next_button.config.assert_called_with(state='disabled')

    def test_double_click_requires_actual_row(self):
        app=main.App.__new__(main.App); app.tree=Mock(); app.edit=Mock()
        event=Mock(x=5,y=5)
        app.tree.identify_region.return_value='heading'; app.double_click(event); app.edit.assert_not_called()
        app.tree.identify_region.return_value='cell'; app.tree.identify_row.return_value=''; app.double_click(event); app.edit.assert_not_called()
        app.tree.identify_row.return_value='1'; app.double_click(event)
        app.tree.selection_set.assert_called_once_with('1'); app.edit.assert_called_once()


if __name__=='__main__': unittest.main()
