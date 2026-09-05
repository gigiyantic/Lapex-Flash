/**
 * Lapex Flash — CodeMirror wrapper around the code editor.
 * The web app's own "one-dark" theme link is dead upstream (404); this
 * panel already reskins CodeMirror via panel.html's own CSS instead of
 * relying on a CodeMirror theme file.
 */
let cmEditor = null;

function initEditor(textareaEl) {
  cmEditor = CodeMirror.fromTextArea(textareaEl, {
    mode: 'text/x-java',
    lineNumbers: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    tabSize: 4,
    indentUnit: 4,
    extraKeys: {
      'Ctrl-Space': (cm) => CodeMirror.showHint(cm, sfAutocompleteHint, { completeSingle: false }),
      'Ctrl-Enter': () => execCurrentMode(),
      'Cmd-Enter':  () => execCurrentMode(),
    },
  });

  cmEditor.on('inputRead', (cm, change) => {
    if (change.text && change.text[0] === '.') {
      CodeMirror.showHint(cm, sfAutocompleteHint, { completeSingle: false });
    }
  });

  return cmEditor;
}

function getCode() {
  return cmEditor.getValue();
}

function setCode(str) {
  cmEditor.setValue(str || '');
}

function setEditorMode(mode) {
  cmEditor.setOption('mode', mode === 'soql' ? 'text/x-sql' : 'text/x-java');
}

function focusEditor() {
  cmEditor.focus();
}
