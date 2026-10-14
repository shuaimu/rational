#!/usr/bin/env python3
"""Generate synthetic workbook/ZIP metadata without embedding private portfolios."""
import base64,io,json,zipfile,zlib
from pathlib import Path

def fixture(rows):
    headers=['Account','Ticker','Type','Quantity','Price','Cost','Fees','Date']
    values=[headers]+[['SERVERLESS_FIXTURE','TEST','Buy',1,12.5,12.5,0,'2026-09-26']]*rows
    xml=[]
    for i,row in enumerate(values,1):
        cells=[]
        for j,value in enumerate(row):
            ref=f'{chr(65+j)}{i}'
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>' if isinstance(value,str) else f'<c r="{ref}"><v>{value}</v></c>')
        xml.append(f'<row r="{i}">'+''.join(cells)+'</row>')
    parts={
        '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="History" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+''.join(xml)+'</sheetData></worksheet>',
    }
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,contents in parts.items():archive.writestr(name,contents)
    return stream.getvalue()
small=fixture(2);representative=fixture(8000)
# Padding is a valid stored, unreferenced entry; size tests transfer/reassembly,
# while the separate 8000-row fixture tests representative parser work.
name='qualification-padding.bin'
padding_size=50*1024*1024-len(small)-(30+len(name))-(46+len(name))
payload={'small':base64.b64encode(small).decode(),'representative':base64.b64encode(representative).decode(),'paddingName':name,'paddingSize':padding_size,'paddingCrc32':zlib.crc32(bytes(padding_size))}
Path('mako/serverless/qualification/workbook-fixtures.json').write_text(json.dumps(payload)+'\n')
print('Synthetic workbook fixture sizes:',len(small),len(representative))
