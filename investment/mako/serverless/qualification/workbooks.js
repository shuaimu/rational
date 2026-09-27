import fixtures from './workbook-fixtures.json' with {type:'json'};
const decode = value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export function maximumWorkbook() {
 const source=decode(fixtures.small),name=new TextEncoder().encode(fixtures.paddingName);
 const end=new DataView(source.buffer,source.byteOffset+source.length-22,22);
 const offset=end.getUint32(16,true),directoryLength=end.getUint32(12,true);
 const localLength=30+name.length+fixtures.paddingSize,centralLength=46+name.length;
 const result=new Uint8Array(source.length+localLength+centralLength);
 result.set(source.subarray(0,offset));
 const local=new DataView(result.buffer,offset,localLength);
 local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint32(14,fixtures.paddingCrc32,true);
 local.setUint32(18,fixtures.paddingSize,true);local.setUint32(22,fixtures.paddingSize,true);local.setUint16(26,name.length,true);
 result.set(name,offset+30);
 result.set(source.subarray(offset,source.length-22),offset+localLength);
 const centralOffset=offset+localLength+directoryLength;
 const central=new DataView(result.buffer,centralOffset,centralLength);
 central.setUint32(0,0x02014b50,true);central.setUint16(4,20,true);central.setUint16(6,20,true);
 central.setUint32(16,fixtures.paddingCrc32,true);central.setUint32(20,fixtures.paddingSize,true);central.setUint32(24,fixtures.paddingSize,true);
 central.setUint16(28,name.length,true);central.setUint32(42,offset,true);result.set(name,centralOffset+46);
 result.set(source.subarray(source.length-22),result.length-22);
 const final=new DataView(result.buffer,result.length-22,22);
 final.setUint16(8,end.getUint16(8,true)+1,true);final.setUint16(10,end.getUint16(10,true)+1,true);
 final.setUint32(12,directoryLength+centralLength,true);final.setUint32(16,offset+localLength,true);
 return result;
}
export function qualifyWorkbook(parse,kind) {
 const bytes=kind==='maximum'?maximumWorkbook():decode(fixtures.representative);
 const started=performance.now();const rows=JSON.parse(parse(bytes));
 if(rows.length!==(kind==='maximum'?2:8000)) throw new Error('workbook_count');
 return {bytes:bytes.length,rows:rows.length,milliseconds:performance.now()-started,kind};
}
