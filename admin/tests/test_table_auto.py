import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import core

class TableAutoTests(unittest.TestCase):
    def test_header_alias_and_folder_path_auto_default(self):
        rows=core.read_tsv('\ufeff주소\t이름\t폴더\t포트\t프로토콜\n192.0.2.10\t한글 장비\t폴더1/폴더2\t22\tSSH\n')
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['name'],rows[0]['host'],rows[0]['folder']),('한글 장비','192.0.2.10','폴더1/폴더2'))

    def test_noheader_consistency_manual_and_csv(self):
        for count in (0,7,16):
            row=['폴더']*count+['장비','2001:db8::10','ssh','65535']
            self.assertEqual(core.rows_from_table([row])[0]['host'],'2001:db8::10')
            self.assertEqual(core.rows_from_table([row],count,False)[0]['folder'],'/'.join(['폴더']*count))
        for table in ([['a','192.0.2.10','ssh','0']], [['a','999.1.1.1','ssh','22']], [['a','host','ftp','21']], [['a','host','ssh','22'],['f','b','host','ssh','22']], [['name','host','address','protocol','port'],['a','host','other','ssh','22']]):
            with self.assertRaises(core.ValidationError): core.rows_from_table(table)
        text='\ufeff폴더,이름,주소,프로토콜,포트\r\n폴더1/폴더2,"예시, ""장비""",192.0.2.10,ssh,22\r\n'
        self.assertEqual(core.read_csv(text)[0]['name'],'예시, "장비"')
        self.assertEqual(core.read_csv(core.sample_csv().decode('utf-8-sig'))[1]['host'],'examplehost')
        with self.assertRaises(core.ValidationError): core.read_csv('"unterminated')

    def test_blank_trailing_and_bom_quote(self):
        rows=core.read_tsv('\ufeff"폴더1"\t장비\t192.0.2.10\tssh\t22\t\t\r\n폴더2\t다른장비\texamplehost\ttelnet\t23\t\r\n')
        self.assertEqual(rows[0]['folder'],'폴더1')
        self.assertEqual(len(rows),2)

    def test_xlsx_auto_and_ui_defaults(self):
        from openpyxl import Workbook
        import tempfile, ui
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'sample.xlsx'; wb=Workbook(); ws=wb.active
            ws.append(['폴더1','폴더2','이름','주소','프로토콜','포트'])
            ws.append(['폴더1',None,'한글','192.0.2.10','ssh',22]); wb.save(p); wb.close()
            self.assertEqual(core.read_xlsx(p,'Sheet')[0]['folder'],'폴더1')
        self.assertIn('자동',ui.import_columns('auto',False))
        source=(Path(__file__).resolve().parents[1]/'main.py').read_text(encoding='utf-8')
        self.assertIn("value='자동'",source)
        self.assertIn('core.read_csv',source)

if __name__=='__main__': unittest.main()
