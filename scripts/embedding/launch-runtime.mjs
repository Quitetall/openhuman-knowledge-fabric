#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { protectedPath } from './runtime-inventory.mjs';
import { verifyRuntime } from './verify-runtime.mjs';

// -I ignores inherited Python variables and current-directory imports. -S disables
// .pth/sitecustomize execution, then only the inventoried package tree and protected
// provider directory are added explicitly. No virtual-environment path survives.
const BOOTSTRAP = `import runpy,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1]+"/lib/python3.13/site-packages")
sys.path.insert(0,sys.argv[2])
provider=sys.argv[2]+"/serve.py"
sys.argv=[provider,"--model-dir",sys.argv[3],"--port",sys.argv[4]]
runpy.run_path(provider,run_name="__main__")
`;

try {
  if (process.argv.length !== 7) throw new Error('runtime_usage_invalid');
  const [root, pin, provider, model, port] = process.argv.slice(2);
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('runtime_port_invalid');
  }
  const python = verifyRuntime(root, pin);
  for (const name of ['model.py', 'transport.py', 'serve.py']) {
    const path = join(provider, name);
    protectedPath(path);
    if (!lstatSync(path).isFile()) throw new Error('runtime_provider_invalid');
  }
  protectedPath(model);
  const child = spawn(python, ['-I', '-S', '-c', BOOTSTRAP, root, provider, model, port], {
    stdio: 'inherit',
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: '/nonexistent',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      OMP_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  const forward = (signal) => child.kill(signal);
  const terminate = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.on('error', () => {
    process.stderr.write('embedding_runtime_launch_refused\n');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1);
  });
} catch {
  process.stderr.write('embedding_runtime_launch_refused\n');
  process.exitCode = 1;
}
