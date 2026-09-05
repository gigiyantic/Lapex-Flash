/**
 * Lapex Flash — dev-only hot reload.
 * Polls the extension's own unpacked files for changes and calls
 * chrome.runtime.reload() automatically. Chrome injects "update_url"
 * into the manifest for any Web-Store-installed extension, but never
 * for one loaded unpacked — so this only ever runs during development,
 * and is a safe no-op in the real published extension.
 */
(function () {
  if ('update_url' in chrome.runtime.getManifest()) return;

  const POLL_MS = 1000;
  let lastSignature = null;
  let isFirstCheck = true;
  let checking = false;

  function walk(entry, out, done) {
    if (entry.isFile) {
      entry.getMetadata(meta => {
        out.push(entry.fullPath + ':' + meta.modificationTime.getTime());
        done();
      }, done);
      return;
    }
    if (!entry.isDirectory) { done(); return; }

    const reader = entry.createReader();
    const children = [];
    (function readBatch() {
      reader.readEntries(batch => {
        if (batch.length === 0) {
          let pending = children.length;
          if (pending === 0) { done(); return; }
          children.forEach(child => walk(child, out, () => { if (--pending === 0) done(); }));
        } else {
          children.push(...batch);
          readBatch();
        }
      }, done);
    })();
  }

  function checkForChanges() {
    if (checking) return;
    checking = true;
    chrome.runtime.getPackageDirectoryEntry(rootEntry => {
      const files = [];
      walk(rootEntry, files, () => {
        checking = false;
        const signature = files.sort().join('|');
        if (isFirstCheck) {
          lastSignature = signature;
          isFirstCheck = false;
          return;
        }
        if (signature !== lastSignature) {
          chrome.runtime.reload();
        }
      });
    });
  }

  setInterval(checkForChanges, POLL_MS);
})();
