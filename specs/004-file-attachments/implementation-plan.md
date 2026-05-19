# Desktop File Attachments Implementation Plan

## Goal

Add desktop file upload support so Pueblo can:

1. Open the operating system file picker when the user clicks the `pueblo>` input label.
2. Accept `.txt`, `.docx`, `.xls`, and `.xlsx` uploads in phase 1.
3. Convert uploaded files into canonical JSON assets.
4. Submit user text together with attachment metadata to the task pipeline.
5. Tell the LLM to inspect large uploaded JSON assets with the existing `read` tool instead of forcing the full file into context.

Phase 2 extends the same JSON assets so the LLM can edit them and Pueblo can export the edited JSON back into `.docx` or Excel files.

## Constraints

- `.doc` is explicitly out of scope for phase 1.
- The renderer should not read arbitrary files directly. File selection and parsing belong in Electron main-process services.
- Provider adapters currently accept plain-text message content only. Attachments must therefore be represented as structured JSON context injected into the existing task message builder.
- Large files must not be inlined into prompt content once they exceed a configured threshold.

## Phase 1 Scope

### User Flow

1. User clicks the `pueblo>` label in the input pane.
2. Desktop opens a native file picker.
3. Selected files are parsed and converted into JSON assets.
4. Renderer shows the selected attachments and their parse status.
5. When the user submits input, Pueblo sends:
   - the input text
   - attachment manifest metadata
   - JSON asset paths
   - small attachment summaries or inline excerpts when within threshold
6. The task pipeline injects attachment context into the provider messages before the final user message.

### Supported Formats

- `.txt`
- `.docx`
- `.xls`
- `.xlsx`

### JSON Canonical Shapes

#### Document Assets

Used for `.txt` and `.docx`.

```json
{
  "attachmentId": "att_001",
  "kind": "document",
  "source": {
    "fileName": "notes.docx",
    "originalPath": "D:/docs/notes.docx",
    "extension": ".docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  },
  "asset": {
    "jsonPath": ".../attachments/att_001.json",
    "createdAt": "2026-05-17T10:00:00.000Z",
    "sizeBytes": 12345,
    "editable": true,
    "schemaVersion": 1
  },
  "summary": {
    "chunkCount": 12,
    "isLarge": false
  },
  "content": {
    "chunks": [
      {
        "index": 0,
        "text": "..."
      }
    ]
  }
}
```

#### Spreadsheet Assets

Used for `.xls` and `.xlsx`.

```json
{
  "attachmentId": "att_002",
  "kind": "spreadsheet",
  "source": {
    "fileName": "budget.xlsx",
    "originalPath": "D:/docs/budget.xlsx",
    "extension": ".xlsx",
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  "asset": {
    "jsonPath": ".../attachments/att_002.json",
    "createdAt": "2026-05-17T10:00:00.000Z",
    "sizeBytes": 12345,
    "editable": true,
    "schemaVersion": 1
  },
  "summary": {
    "sheetCount": 3,
    "cellCount": 412,
    "isLarge": true
  },
  "content": {
    "sheets": [
      {
        "name": "Sheet1",
        "rows": [
          {
            "rowIndex": 1,
            "cells": [
              {
                "column": "A",
                "address": "A1",
                "value": "Name"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

## Phase 1 Architecture

### Renderer

- Track pending uploaded attachments in local state.
- Trigger file selection from the input label.
- Render attachment chips or rows near the input pane.
- Submit an `IpcInputEnvelope` instead of a raw string.

### Preload and IPC

- Expose a typed `selectInputFiles()` bridge.
- Change `submitInput()` to accept an envelope.
- Add a main-process upload handler that:
  - opens the file picker
  - validates file types
  - parses file contents
  - writes canonical JSON assets to disk
  - returns attachment manifests to the renderer

### Task Pipeline

- Extend the task input contract to accept uploaded attachment manifests.
- Inject an attachment context system block before the final user message.
- Inline only small JSON excerpts.
- For large assets, provide the JSON path and explicit instructions to use the `read` tool.

## Phase 1 Dependencies

- `mammoth` for `.docx`
- `exceljs` for `.xls` and `.xlsx`

## Phase 1 Acceptance Criteria

1. Clicking the `pueblo>` label opens a native file picker.
2. The picker accepts `.txt`, `.docx`, `.xls`, `.xlsx`.
3. Each selected file is converted into a JSON asset and represented in the UI.
4. Submit input sends the text plus attachment manifests through the existing desktop task pipeline.
5. The provider message builder includes attachment context.
6. Large assets are referenced by JSON path instead of being fully inlined.
7. `npm run build` succeeds.

## Phase 2 Scope

Phase 2 keeps the same canonical JSON assets and adds export-back workflows.

### User Flow

1. The LLM reads and edits the JSON asset files with existing file tools.
2. When a canonical attachment JSON asset is edited successfully, Pueblo automatically rewrites the original `.docx` or Excel file from that JSON.
3. Initial phase 2 delivery overwrites the original source path recorded in the asset metadata.

### Additional Requirements

- Keep provenance metadata stable from phase 1.
- Preserve enough structure for round-trip generation.
- Do not promise full Office style fidelity in phase 2 initial delivery.

### Phase 2 Acceptance Criteria

1. JSON asset files are editable with existing `read` and `edit` flows.
2. Pueblo can convert edited document JSON back into `.docx`.
3. Pueblo can convert edited spreadsheet JSON back into `.xls` or `.xlsx` output.
4. Export is explicit, not automatic.

## Implementation Checklist

### Phase 1

- Add attachment schemas to shared types.
- Extend `IpcInputEnvelope` to include attachments.
- Add desktop file selection and parsing IPC handlers.
- Persist JSON assets under a deterministic attachments directory.
- Update renderer input state and upload UI.
- Update task input contracts and task message builder attachment context.
- Add tests for renderer submit payloads, IPC parsing, and message injection.
- Validate with `npm run build` and targeted tests.

### Phase 2

- Detect canonical attachment JSON edits and trigger automatic source-file export.
- Implement document JSON to `.docx` writer.
- Implement spreadsheet JSON to Excel writer.
- Add tests for export round-trip behavior.