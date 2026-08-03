# ⚡ Apex Flash — Salesforce Developer Studio

**Apex Flash** is a lightweight, ultra-fast, local developer studio for executing Anonymous Apex and running SOQL queries directly against any Salesforce org via Session ID or Username/Password.

## 🚀 Features

- ⚡ **Anonymous Apex Execution**: Highlighting, formatting, color-coded debug logs (`USER_DEBUG`, `EXECUTION_STARTED`, errors).
- 🔍 **SOQL Query Runner**: Interactive query results table, exports (CSV, Markdown, Apex list, cURL), Tooling API support.
- 💡 **Salesforce Inspector-Style Autocomplete**: Autocompletes standard and custom sObjects (`Account`, `Contact`, `Custom_Obj__c`) and field names (`license_type__c`, `Id`, `Name`) with labels and data types.
- 📁 **Separate Workspaces & Custom Tab Renaming**: Independent tabs for Apex and SOQL with double-click or 1-click tab renaming.
- 📂 **Local Log Preservation**: Automatically saves all Apex and SOQL execution logs permanently to `logs/` directory.

## 📦 Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Local Proxy Server**:
   ```bash
   npm start
   # Or run start-server.bat
   ```

3. **Open Studio**:
   Open `http://localhost:3000/apex-executor.html` in your web browser.
