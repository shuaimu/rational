#!/usr/bin/env python3
"""Create a private two-occurrence Excel fixture for a journaled API smoke run."""
import json
import os
from pathlib import Path
import sys
import zipfile
from xml.sax.saxutils import escape

root = Path(sys.argv[1]).resolve()
assert root.stat().st_mode & 0o077 == 0
journal = json.loads((root / 'api-smoke-journal.json').read_text())
source = json.loads((root / 'source.json').read_text())
account = next(r for r in source['public']['accounts'] if r['id'] == journal['accountId'])
ticker = next(r for r in source['public']['tickers'] if r['id'] == journal['tickerId'])
headers = ['Account', 'Ticker', 'Type', 'Quantity', 'Price', 'Cost', 'Fees', 'Date', 'Option', 'Option Type', 'Strike', 'Expiration', 'Status']
row = [account['code'], ticker['symbol'], 'Buy', 1, 12.5, 12.5, 0, '2026-09-24', 'ROBINLAB_SMOKE_' + journal['run'] + '_excel', 'P', 1, '2030-01-18', 'open']
rows = []
for i, values in enumerate([headers, row, row], 1):
    cells = []
    for j, value in enumerate(values):
        ref = chr(65+j) + str(i)
        if isinstance(value, (int, float)):
            cells.append(f'<c r="{ref}"><v>{value}</v></c>')
        else:
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
    rows.append(f'<row r="{i}">' + ''.join(cells) + '</row>')
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="History" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + ''.join(rows) + '</sheetData></worksheet>',
}
path = root / 'smoke-import.xlsx'
if not path.exists():
    with open(path, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, content in parts.items():
                archive.writestr(name, content)
