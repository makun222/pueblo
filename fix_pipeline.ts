import * as fs from 'fs';

const content = fs.readFileSync('src/amber/pipeline.ts', 'utf-8');

// Find the pattern - the exact line matching is needed
const lines = content.split('\n');
let found = false;
for (let i = 0; i < lines.length; i++) {
    // Line: // 标量值
    if (lines[i].trim() === '// 标量值') {
        const nextLine = i + 1; // stack[stack.length-1][key]=value.replace(...)
        if (lines[nextLine].includes('replace(/^[\"')) {
            // Replace lines[i] through lines[i+1] with the fix
            const indent = lines[nextLine].match(/^\s*/)?.[0] || '                    ';
            lines[i] = lines[i].replace('// 标量值', '// 标量值（支持多行双引号字符串）');
            lines[nextLine] = `${indent}let finalVal = value;`;
            lines.splice(i + 2, 0,
                `${indent}if (finalVal.startsWith('"') && !finalVal.endsWith('"')) {`,
                `${indent}    for (let j = i + 1; j < lines.length; j++) {`,
                `${indent}        finalVal += '\\n' + lines[j];`,
                `${indent}        i = j;`,
                `${indent}        if (finalVal.endsWith('"') && !finalVal.endsWith('\\\\"')) {`,
                `${indent}            break;`,
                `${indent}        }`,
                `${indent}    }`,
                `${indent}}`,
                `${indent}stack[stack.length - 1][key] = finalVal.replace(/^["']|["']$/g, '');`
            );
            found = true;
            break;
        }
    }
}

if (found) {
    fs.writeFileSync('src/amber/pipeline.ts', lines.join('\n'), 'utf-8');
    console.log('Fix applied successfully!');
} else {
    console.log('Pattern not found. Searching for alternative...');
    // Search for the replace pattern
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('replace(/^[\"\\\']')) {
            console.log(`Line ${i+1}: ${lines[i]}`);
        }
    }
}
