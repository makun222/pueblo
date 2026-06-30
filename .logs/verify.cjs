const fs=require('fs');  
const p=require('path');  
const d=p.join('D:/WorkSpace/pueblo/pueblo/.logs');  
fs.mkdirSync(d,{recursive:true});  
const logFile=p.join(d,'test-verify.log');  
fs.writeFileSync(logFile,'[INFO] Chinese test: pipeline OK\n','utf-8');  
const read=fs.readFileSync(logFile,'utf-8');  
console.log('DONE:',read);  
