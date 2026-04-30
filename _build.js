const fs=require("fs");
const path=require("path");
function writeFile(filepath,lines){fs.writeFileSync(filepath,lines.join("\n"),"utf8");console.log("wrote:",filepath);}
