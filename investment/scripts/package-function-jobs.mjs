import {mkdir,cp,rm} from 'node:fs/promises';
const root=new URL('../',import.meta.url),destination=new URL('.local/mako-serverless/jobs-bundle/',root);
await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true,mode:0o700});
for(const directory of ['jobs','shared','generated'])await cp(new URL(`mako/serverless/${directory}/`,root),new URL(`${directory}/`,destination),{recursive:true});
