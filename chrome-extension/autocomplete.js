/**
 * Lapex Flash — sObject/field autocomplete hint provider for CodeMirror.
 * Ported from the web app's sfAutocompleteHint(); data source swapped from
 * server fetches to background messages (LIST_SOBJECTS / DESCRIBE).
 */
const SOQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'LIMIT', 'OFFSET', 'ORDER BY', 'GROUP BY', 'HAVING',
  'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
  'TYPEOF', 'WITH SECURITY_ENFORCED', 'USING SYSTEM_MODE', 'WITH USER_MODE',
  'FORMAT', 'CALENDAR_MONTH', 'DAY_ONLY', 'COUNT()', 'AVG()', 'SUM()', 'MAX()', 'MIN()',
];

let sfObjectList = null;
const sfFieldMap = {};

async function getSfObjects() {
  if (sfObjectList) return sfObjectList;
  if (!SF.sessionId || !SF.instanceUrl) return [];
  try {
    const res = await msg('LIST_SOBJECTS', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl });
    sfObjectList = Array.isArray(res.sobjects) ? res.sobjects : [];
    return sfObjectList;
  } catch (_) { return []; }
}

async function getSfFields(sobject) {
  if (!sobject) return [];
  const key = sobject.toLowerCase();
  if (sfFieldMap[key]) return sfFieldMap[key];
  if (!SF.sessionId || !SF.instanceUrl) return [];
  try {
    const res = await msg('DESCRIBE', { sessionId: SF.sessionId, instanceUrl: SF.instanceUrl, sobject });
    if (res.fields) {
      sfFieldMap[key] = res.fields;
      return res.fields;
    }
  } catch (_) {}
  return [];
}

function isInsideSoqlBracket(docUpToCursor) {
  const lastOpen  = docUpToCursor.lastIndexOf('[');
  const lastClose = docUpToCursor.lastIndexOf(']');
  return lastOpen > lastClose && /\bSELECT\b/i.test(docUpToCursor.slice(lastOpen));
}

function sfAutocompleteHint(cm) {
  return new Promise(async (resolve) => {
    const cur      = cm.getCursor();
    const token    = cm.getTokenAt(cur);
    const line     = cm.getLine(cur.line);
    const fullText = cm.getValue();

    const docUpToCursor = cm.getRange(CodeMirror.Pos(0, 0), cur);
    const insideSoql    = isInsideSoqlBracket(docUpToCursor);

    let word  = token.string;
    let start = token.start;
    let end   = token.end;

    if (!/^[a-zA-Z0-9_]+$/.test(word)) {
      word = '';
      start = cur.ch;
      end = cur.ch;
    }

    const wordLower = word.toLowerCase();
    const list = [];
    const addedSet = new Set();

    function addSuggestion(text, typeLabel, label, priority = 0) {
      const k = text.toLowerCase();
      if (addedSet.has(k)) return;
      addedSet.add(k);
      list.push({
        text,
        displayText: label ? `${text} — ${label}` : text,
        priority,
        render: (el, _self, data) => {
          el.innerHTML = `<span style="font-weight:600;">${esc(data.text)}</span>${typeLabel ? `<span class="cm-hint-type">${esc(typeLabel)}</span>` : ''}`;
        },
      });
    }

    let isDotNotation = false;
    let dotParent = '';

    const charBefore = line.charAt(start - 1);
    if (charBefore === '.') {
      isDotNotation = true;
      const prevToken = cm.getTokenAt(CodeMirror.Pos(cur.line, start - 1));
      if (prevToken && prevToken.string && /^[a-zA-Z0-9_]+$/.test(prevToken.string)) {
        dotParent = prevToken.string;
      }
    }

    const isAfterFrom = /\b(FROM|INTO)\s+([a-zA-Z0-9_]*)$/i.test(docUpToCursor);

    let soqlSObject = '';
    const fromMatches = Array.from(fullText.matchAll(/\bFROM\s+([a-zA-Z0-9_]+)/gi));
    if (fromMatches.length > 0) {
      soqlSObject = fromMatches[fromMatches.length - 1][1];
      getSfFields(soqlSObject);
    }

    if (isAfterFrom) {
      const sobjects = await getSfObjects();
      sobjects.forEach(obj => {
        const nameL = obj.name.toLowerCase();
        const labelL = (obj.label || '').toLowerCase();
        if (!wordLower || nameL.includes(wordLower) || labelL.includes(wordLower)) {
          const starts = nameL.startsWith(wordLower) || labelL.startsWith(wordLower);
          addSuggestion(obj.name, obj.label || 'sObject', obj.label, starts ? 2 : 1);
        }
      });
    } else if (isDotNotation && dotParent) {
      let targetObj = dotParent;
      const parentLower = dotParent.toLowerCase();
      if (['owner', 'createdby', 'lastmodifiedby'].includes(parentLower)) {
        targetObj = 'User';
      }
      const fields = await getSfFields(targetObj);
      fields.forEach(f => {
        const nameL = f.name.toLowerCase();
        const labelL = (f.label || '').toLowerCase();
        if (!wordLower || nameL.includes(wordLower) || labelL.includes(wordLower)) {
          const starts = nameL.startsWith(wordLower) || labelL.startsWith(wordLower);
          addSuggestion(f.name, `${f.label} · ${f.type}`, f.label, starts ? 2 : 1);
        }
      });
    } else if (soqlSObject && (getCurrentMode() === 'soql' || insideSoql)) {
      const fields = await getSfFields(soqlSObject);
      fields.forEach(f => {
        const nameL = f.name.toLowerCase();
        const labelL = (f.label || '').toLowerCase();
        if (!wordLower || nameL.includes(wordLower) || labelL.includes(wordLower)) {
          const starts = nameL.startsWith(wordLower) || labelL.startsWith(wordLower);
          addSuggestion(f.name, `${f.label} · ${f.type}`, f.label, starts ? 3 : 2);
        }
      });
      SOQL_KEYWORDS.forEach(kw => {
        if (!wordLower || kw.toLowerCase().startsWith(wordLower)) {
          addSuggestion(kw, 'Keyword', null, 1);
        }
      });
    } else if (getCurrentMode() === 'soql' || insideSoql || isDotNotation) {
      const sobjects = await getSfObjects();
      sobjects.forEach(obj => {
        const nameL = obj.name.toLowerCase();
        const labelL = (obj.label || '').toLowerCase();
        if (!wordLower || nameL.includes(wordLower) || labelL.includes(wordLower)) {
          const starts = nameL.startsWith(wordLower) || labelL.startsWith(wordLower);
          addSuggestion(obj.name, obj.label || 'sObject', obj.label, starts ? 2 : 1);
        }
      });
      SOQL_KEYWORDS.forEach(kw => {
        if (!wordLower || kw.toLowerCase().startsWith(wordLower)) {
          addSuggestion(kw, 'Keyword', null, 1);
        }
      });
    }

    if (list.length === 0) return resolve(null);

    list.sort((a, b) => b.priority - a.priority || a.text.localeCompare(b.text));

    resolve({
      list: list.slice(0, 150),
      from: CodeMirror.Pos(cur.line, start),
      to: CodeMirror.Pos(cur.line, end),
    });
  });
}
