const fs=require('fs');  
const p=require('path');  
const d='D:/WorkSpace/pueblo/pueblo/.logs';  
const content='[2026-06-24T10:30:45][INFO] [amber] 蓝色便签pipeline加载成功 → 进入phase analysis\n';  
fs.writeFileSync(p.join(d,'amber-verify.log'),content,'utf-8');  
const read=fs.readFileSync(p.join(d,'amber-verify.log'),'utf-8');  
console.log('CONTENT:',JSON.stringify(read));  
const buf=Buffer.from(read);  
