// Code runs in a disposable worker, so an infinite loop cannot block the screen.
export function javascriptTestDocument(code: string) {
  const worker = `self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined; self.importScripts = undefined;
const logs = [];
const console = { log: (...args) => { if (logs.length < 100) logs.push(args.map(String).join(' ').slice(0, 1000)); } };
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
try { new Function('console', 'assert', ${JSON.stringify(code)})(console, assert); postMessage({ok:true, logs}); }
catch(error) { postMessage({ok:false, logs, error:String(error).slice(0,1000)}); }`;
  const encoded = JSON.stringify(worker).replace(/</g, "\\u003c");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'"><script>
let worker;
let timer;
const finish = result => { clearTimeout(timer); worker?.terminate(); window.ReactNativeWebView.postMessage(JSON.stringify(result)); };
timer = setTimeout(() => finish({ok:false,error:'Test exceeded the 2-second limit.'}), 2000);
try {
worker = new Worker(URL.createObjectURL(new Blob([${encoded}], {type:'application/javascript'})));
worker.onmessage = event => finish(event.data);
worker.onerror = () => finish({ok:false,error:'JavaScript test could not start.'});
} catch { finish({ok:false,error:'JavaScript test could not start.'}); }
</script>`;
}
