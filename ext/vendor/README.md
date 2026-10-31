Third-party libraries, unmodified except for removed source-map comments.

`vendor.json` records where every file comes from and its SHA-256. `node tools/vendor-check.mjs --upstream --osv` re-downloads each library from its published source, compares the bytes, and looks up known vulnerabilities in the OSV database; GitHub Actions runs it on every change here, weekly, and before each release.

| Library | Version | License | Files |
|---|---|---|---|
| PDF.js (pdfjs-dist) | 6.4.299 | Apache-2.0 | pdfjs/ |
| docx-preview | 0.4.1 | Apache-2.0 | docx-preview.min.js |
| JSZip | 3.10.2 | MIT (dual MIT/GPL-3.0) | jszip.min.js |
| SheetJS Community Edition | 0.20.3 (from cdn.sheetjs.com; npm stops at 0.18.5) | Apache-2.0 | xlsx.full.min.js |
| DOMPurify | 3.4.17 | Apache-2.0 or MPL-2.0 | purify.min.js |
