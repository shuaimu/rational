// A credential-free replacement for retained source writer/qualification entry
// points. Deploy only after draining; it cannot reach storage or providers.
export function retiredWriter() {
 return new Response(JSON.stringify({error:'This Investment environment is closed for migration. Use Rational Investment at https://shuaimu.github.io/rational/investment/.'}),{
  status:503,headers:{'content-type':'application/json','cache-control':'no-store'},
 });
}
