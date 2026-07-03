import * as fs from 'fs';

// Copy of parseSimpleYaml from pipeline.ts for diagnosis
function parseSimpleYaml(content: string): any {
  const lines = content.split('\n');
  const root: any = {};
  const stack: any[] = [root];
  const stackIndents: number[] = [0];
  const listCtxStack: { key: string; container: any; indent: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const indent = raw.search(/\S/);
    if (indent === -1) continue;
    const line = raw.trim();

    // 后退栈到当前缩进级别
    while (stack.length > 1 && indent < stackIndents[stack.length - 1]) {
      stack.pop();
      stackIndents.pop();
    }
    while (listCtxStack.length > 0 && indent < listCtxStack[listCtxStack.length - 1].indent) {
      listCtxStack.pop();
    }

    const currentListCtx = listCtxStack.length > 0 ? listCtxStack[listCtxStack.length - 1] : null;

    const listMatch = /^-\s+/.test(line);
    const kvMatch = line.match(/^(\s*)([\w-]+):\s*(.*)/);

    if (currentListCtx && /^-\s+([\w-]+):/.test(line)) {
      const nestedKv = line.match(/^\s*-\s+([\w-]+):\s*(.*)/);
      if (nestedKv) {
        // 弹出到列表容器
        while (stack.length > 0 && stack[stack.length - 1] !== currentListCtx.container) {
          stack.pop();
          stackIndents.pop();
        }
        if (!Array.isArray(currentListCtx.container[currentListCtx.key])) {
          currentListCtx.container[currentListCtx.key] = [];
        }
        const arr = currentListCtx.container[currentListCtx.key];
        const newObj: any = {};
        const key = nestedKv[1];
        let value: any = nestedKv[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        newObj[key] = value;
        arr.push(newObj);
        stack.push(newObj);
        stackIndents.push(indent);
      }
    } else if (kvMatch) {
      const key = kvMatch[2];
      let val = kvMatch[3].trim();

      if (val === '') {
        const newNode: any = {};
        stack[stack.length - 1][key] = newNode;
        stack.push(newNode);
        stackIndents.push(indent);
        listCtxStack.push({ key, container: newNode, indent });
      } else {
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        stack[stack.length - 1][key] = val;
      }
    }
    // else: lines not matching are discarded
  }
  return root;
}

const content = fs.readFileSync('.amber/init/meta-pipeline.yaml', 'utf-8');
console.log('=== Raw content ===');
console.log(content);
console.log('\n=== Parsed JSON ===');
const parsed = parseSimpleYaml(content);
console.log(JSON.stringify(parsed, null, 2));
