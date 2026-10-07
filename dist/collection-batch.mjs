export const batchLimit=300;
export function parseCollectionCodes(value){
  if(typeof value!=='string'&&!Array.isArray(value))throw Error('请输入股票代码列表。');
  if(typeof value==='string'&&value.length>20000)throw Error('代码列表过长，请分批提交。');
  const tokens=Array.isArray(value)?value:value.trim().split(/[\s,，;；、]+/u).filter(Boolean);
  if(!tokens.length)throw Error('至少输入一只股票代码。');
  const invalid=tokens.filter(x=>typeof x!=='string'||!/^\d{6}$/.test(x));
  if(invalid.length)throw Error('股票代码须为六位数字：'+invalid.slice(0,8).join('、'));
  const symbols=[...new Set(tokens)];
  if(symbols.length>batchLimit)throw Error(`每批最多 ${batchLimit} 只股票，请拆分提交。`);
  return {symbols,duplicates:tokens.length-symbols.length};
}
