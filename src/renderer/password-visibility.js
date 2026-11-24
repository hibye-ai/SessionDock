// One definition of the reveal/eye glyph pair so every password field in the
// app (session dialog, auth prompt, batch runner, credential manager) looks and
// behaves the same. Kept free of DOM assumptions so it is safe to import from
// any renderer module.
export const PASSWORD_ICONS = Object.freeze({
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24 M1 1l22 22'
});

// `visible` is the state the field will be in, so a visible password shows the
// crossed-out eye (the action is "hide").
export function passwordIcon(visible) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${visible ? PASSWORD_ICONS.eyeOff : PASSWORD_ICONS.eye}"/></svg>`;
}

export function passwordToggleLabel(title, visible) {
  return `${title} ${visible ? '숨기기' : '보기'}`;
}

// Applies the field type, glyph, pressed state and accessible name together so
// no caller can leave a revealed field with a "show" label.
export function applyPasswordVisibility(input, toggle, visible, title) {
  const label = passwordToggleLabel(title, visible);
  input.type = visible ? 'text' : 'password';
  if (toggle) {
    toggle.innerHTML = passwordIcon(visible);
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  return label;
}
