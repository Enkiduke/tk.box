import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {requireThat} from '../errors.js';

// Sets KEY="value" lines in .env text, replacing a key's line where it has one and appending it otherwise,
// keeping every other line, comment and the file's line endings. A key written twice is refused, not guessed at.
export function setEnvValues(text:string,values:Record<string,string>) {
  const newline=text.includes('\r\n')?'\r\n':'\n';let next=text;
  for(const [key,value] of Object.entries(values)) {
    requireThat(/^[A-Z][A-Z0-9_]*$/.test(key)&&!/[\r\n]/.test(value),'SETUP_INVALID_VALUE','A setting value cannot span lines.');
    requireThat(!value.includes("'")||!value.includes('"'),'SETUP_INVALID_VALUE','A setting value cannot hold both kinds of quote.');
    const pattern=new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`,'gm'),matches=[...next.matchAll(pattern)];
    requireThat(matches.length<=1,'SETUP_CONFIG_AMBIGUOUS',`Remove the duplicate ${key} line from .env first.`);
    // Single quotes are read literally, so a Windows path's backslashes (C:\new\...) aren't taken for \n.
    const line=`${key}=${value.includes("'")?`"${value}"`:`'${value}'`}`;
    next=matches.length?next.replace(pattern,()=>line):`${next&&!next.endsWith('\n')?next+newline:next}${line}${newline}`;
  }
  return next;
}
// Writes the values into the .env file at `path`, creating it when there is none, through a temporary file so a
// crash never leaves half a file.
export async function writeEnvValues(path:string,values:Record<string,string>) {
  const original=await readFile(path,'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return '';throw e;});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {await writeFile(temporary,setEnvValues(original,values),{flag:'wx',mode:0o600});await rename(temporary,path);}
  finally{await unlink(temporary).catch(()=>{});}
}
