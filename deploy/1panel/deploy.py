#!/usr/bin/env python3
"""保留现有 Compose 配置的插件部署；不登录、不调用模型或合成服务。"""
import copy
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time

ROOT = Path('/opt/openclaw-xiaoai')
SOURCE = ROOT / 'source'
RUNTIME = ROOT / 'runtime/compose.json'
BASE = ROOT / 'runtime/base.json'
ENTRY_FILE = ROOT / 'compose.yaml'
REGISTRY = Path('/etc/yklx-update/projects.conf')
CONTAINER = 'openclaw-xiaoai'
SERVICE = 'openclaw-gateway'
PLUGIN = '/home/node/.openclaw/extensions/openclaw-plugin-xiaoai-cloud'
ENTRY = 'openclaw-xiaoai|OpenClaw 小爱|/opt/openclaw-xiaoai/source|main|deploy/1panel/update.sh|deploy/1panel/compose.yaml|openclaw-gateway'


class DeployError(Exception):
    pass


def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        # Docker/Compose 输出可能包含环境变量和凭据，禁止直接打印。
        raise DeployError(f'{args[0]} {args[1]} 失败（退出码 {result.returncode}）；错误输出已隐藏。')
    return result.stdout


def private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as output:
        output.write(value)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def write_json(path, value):
    private_write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def register(registry=REGISTRY):
    lines = registry.read_text(encoding='utf-8').splitlines(keepends=True)
    output, found = [], False
    for line in lines:
        if line.split('|', 1)[0] == 'openclaw-xiaoai':
            if not found:
                output.append(ENTRY + '\n')
                found = True
        else:
            output.append(line)
    if not found:
        if output and not output[-1].endswith('\n'):
            output[-1] += '\n'
        output.append(ENTRY + '\n')
    private_write(registry, ''.join(output))


def compose(*args):
    return run(['docker', 'compose', '--project-directory', str(ROOT), '-f', str(ENTRY_FILE), *args])


def inspect():
    return json.loads(run(['docker', 'inspect', CONTAINER]))[0]


def load_model(old):
    labels = old['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != 'openclaw-xiaoai' or labels.get('com.docker.compose.service') != SERVICE:
        raise DeployError('容器不属于预期 Compose 项目，停止迁移。')
    # 校验配置哈希，拒绝使用已经偏离运行容器的旧 Compose 文件。
    hashes = compose('config', '--hash', SERVICE).splitlines()
    actual_hash = next((line.split()[-1] for line in hashes if line.split()[0] == SERVICE), '')
    if not actual_hash or actual_hash != labels.get('com.docker.compose.config-hash'):
        raise DeployError('当前 Compose 配置与运行容器不一致，停止迁移；请先核对配置，不强制覆盖。')
    model = json.loads(compose('config', '--format', 'json'))
    if set(model.get('services', {})) != {SERVICE}:
        raise DeployError('本部署只接管单个 openclaw-gateway 服务。')
    service = model['services'][SERVICE]
    if service.get('container_name') != CONTAINER:
        raise DeployError('容器名称与现有部署不一致。')
    if not service.get('healthcheck') or service['healthcheck'].get('disable'):
        raise DeployError('现有 Compose 未配置容器健康检查，停止迁移。')
    command = old['Config'].get('Cmd') or []
    if '--port' not in command or command[command.index('--port') + 1:command.index('--port') + 2] != ['18789']:
        raise DeployError('当前网关端口不是已验证的 18789，停止迁移。')
    state_mount = next((m for m in old['Mounts'] if m['Destination'] == '/home/node/.openclaw'), None)
    if not state_mount or state_mount['Type'] != 'bind' or not state_mount.get('RW'):
        raise DeployError('需要现有可写的 .openclaw 数据目录 bind 挂载；不猜测或迁移数据库。')
    return model


def pinned_base(old):
    if BASE.exists():
        reference = json.loads(BASE.read_text())['image']
    else:
        version = run(['docker', 'exec', CONTAINER, 'node', '-p', "require('/app/package.json').version"]).strip()
        if version != '2026.10.8':
            raise DeployError('当前宿主并非已验证的 OpenClaw 2026.10.8，停止迁移。')
        image = json.loads(run(['docker', 'image', 'inspect', old['Image']]))[0]
        references = [r for r in image.get('RepoDigests', []) if re.fullmatch(r'ghcr.io/openclaw/openclaw@sha256:[0-9a-f]{64}', r)]
        if len(references) != 1:
            raise DeployError('无法确定当前 OpenClaw 镜像摘要，停止迁移。')
        reference = references[0]
    if not re.fullmatch(r'ghcr.io/openclaw/openclaw@sha256:[0-9a-f]{64}', reference):
        raise DeployError('基础镜像固定摘要无效。')
    return reference


def candidate_model(model, image, release):
    candidate = copy.deepcopy(model)
    service = candidate['services'][SERVICE]
    service.pop('build', None)
    service.pop('pull_policy', None)
    service['image'] = image
    volumes = [v for v in service.get('volumes', []) if v.get('target') != PLUGIN]
    volumes.append({'type': 'bind', 'source': str(release / 'plugin'), 'target': PLUGIN,
                    'read_only': True, 'bind': {'create_host_path': False}})
    service['volumes'] = volumes
    return candidate


def escape(value):
    # config --format json 已完成插值，写回 Compose 时必须转义字面 $。
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [escape(v) for v in value]
    if isinstance(value, dict):
        return {k: escape(v) for k, v in value.items()}
    return value


def build(image, base, revision):
    log = ROOT / 'build.log'
    with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as output:
        result = subprocess.run(['docker', 'build', '--progress=plain', '--build-arg', f'OPENCLAW_BASE={base}',
                                 '-f', str(SOURCE / 'deploy/1panel/Dockerfile'), '-t', image, str(SOURCE)],
                                stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise DeployError('镜像构建失败，旧服务保持运行。完整构建日志仅管理员可读：/opt/openclaw-xiaoai/build.log')
    # 镜像中确认依赖存在，无网络调用。
    run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c',
         "ffmpeg -version >/dev/null && python3 -c 'import requests' && node --check /opt/xiaoai-plugin/dist/index.js"])
    release = ROOT / 'releases' / (revision + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    release.mkdir(parents=True, mode=0o755)
    probe = run(['docker', 'create', '--network', 'none', '--entrypoint', 'true', image]).strip()
    try:
        run(['docker', 'cp', probe + ':/opt/xiaoai-plugin', str(release / 'plugin')])
    finally:
        run(['docker', 'rm', '-v', probe])
    return release


def backup_data(old, backup):
    # 在停止后复制，保留 SQLite/WAL 与登录态的一致快照，不自动恢复数据。
    seen = set()
    with tarfile.open(backup / 'data.tar', 'w') as archive:
        for i, mount in enumerate(old['Mounts']):
            source = mount['Source']
            if source not in seen:
                archive.add(source, arcname=f'mount-{i}', recursive=True)
                seen.add(source)


def check_ready():
    for _ in range(90):
        state = inspect()['State']
        if not state.get('Running'):
            raise DeployError('新容器退出。')
        if state.get('Health', {}).get('Status') == 'healthy':
            # 仅 GET 健康/页面/鉴权入口，不调用模型、登录或语音服务。
            run(['docker', 'exec', CONTAINER, 'node', '-e',
                 "(async()=>{const fs=require('fs');const root='/home/node/.openclaw/extensions/openclaw-plugin-xiaoai-cloud/';if(require(root+'package.json').version!=='1.1.0'||!fs.existsSync(root+'dist/src/speech.js'))process.exit(1);for(const [p,ok] of [['/healthz',[200]],['/',[200]],['/api/xiaoai-cloud/api/speech/settings',[401]]]){const r=await fetch('http://127.0.0.1:18789'+p,{redirect:'manual',signal:AbortSignal.timeout(5000)});if(!ok.includes(r.status))process.exit(1)}})().catch(()=>process.exit(1))"])
            return
        time.sleep(2)
    raise DeployError('容器健康检查超时。')


def switch(old, candidate, backup):
    original_entry = ENTRY_FILE.read_text(encoding='utf-8')
    original_runtime = RUNTIME.read_text(encoding='utf-8') if RUNTIME.exists() else None
    private_write(backup / 'compose.yaml', original_entry)
    if original_runtime is not None:
        private_write(backup / 'compose.json', original_runtime)
    stopped = False
    try:
        compose('stop', SERVICE)
        stopped = True
        backup_data(old, backup)
        write_json(RUNTIME, escape(candidate))
        private_write(ENTRY_FILE, 'name: openclaw-xiaoai\ninclude:\n  - path: /opt/openclaw-xiaoai/runtime/compose.json\n')
        compose('up', '-d', '--no-build', '--pull', 'never', SERVICE)
        check_ready()
    except Exception:
        if stopped:
            # 旧配置可能使用 latest，回滚也固定到更新前的本地镜像 ID。
            rollback = json.loads((backup / 'model.json').read_text(encoding='utf-8'))
            rollback['services'][SERVICE]['image'] = old['Image']
            rollback['services'][SERVICE].pop('build', None)
            rollback['services'][SERVICE].pop('pull_policy', None)
            write_json(RUNTIME, escape(rollback))
            private_write(ENTRY_FILE, 'name: openclaw-xiaoai\ninclude:\n  - path: /opt/openclaw-xiaoai/runtime/compose.json\n')
            compose('up', '-d', '--no-build', '--pull', 'never', SERVICE)
            check_ready_rollback()
        raise


def check_ready_rollback():
    for _ in range(90):
        state = inspect()['State']
        if state.get('Running') and state.get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(2)
    raise DeployError('旧版本恢复后健康检查未通过，请保留备份并检查容器。')


def deploy(action):
    if os.geteuid() != 0:
        raise DeployError('请使用 root 或 sudo 执行。')
    os.umask(0o077)
    if Path(sys.argv[2]).resolve() != SOURCE or sys.argv[3] != 'main':
        raise DeployError('部署目录必须为 /opt/openclaw-xiaoai/source，分支为 main。')
    if not REGISTRY.is_file() or not Path('/usr/local/bin/yklx-update').is_file():
        raise DeployError('现有 yklx-update 或注册表不存在。')
    if run(['git', '-C', str(SOURCE), 'branch', '--show-current']).strip() != 'main' or run(['git', '-C', str(SOURCE), 'status', '--porcelain']).strip():
        raise DeployError('需要干净的 main 工作区。')
    import fcntl
    with open(ROOT / 'deploy.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError('另一项更新正在运行。') from None
        old = inspect()
        if not old['State'].get('Running'):
            raise DeployError('请先恢复现有 OpenClaw 服务。')
        model = load_model(old)
        if action == 'install' and BASE.exists():
            check_ready()
            register()
            print('已有部署健康；菜单注册已核对，无重复安装。')
            return
        if action == 'update' and not BASE.exists():
            raise DeployError('请先运行 install.sh 接入现有容器。')
        base = pinned_base(old)
        revision = run(['git', '-C', str(SOURCE), 'rev-parse', '--short=12', 'HEAD']).strip()
        image = 'openclaw-xiaoai:git-' + revision
        print(f'构建插件版本 {revision}，旧服务保持运行……', flush=True)
        release = build(image, base, revision)
        candidate = candidate_model(model, image, release)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = ROOT / 'backups' / (stamp + '-' + revision)
        backup.mkdir(parents=True, mode=0o700)
        write_json(backup / 'container.json', old)
        write_json(backup / 'model.json', model)
        switch(old, candidate, backup)
        write_json(BASE, {'image': base, 'version': '2026.10.8'})
        register()
        state = inspect()['State']
        print(f'OpenClaw 小爱 {revision} 更新完成：{state["Health"]["Status"]}；备份 {backup}')
        # 只输出日志行数，原始日志可能有登录链接和凭据，不能直接 tail。
        logs = run(['docker', 'logs', '--tail', '12', CONTAINER])
        for line in logs.splitlines()[-6:]:
            match = re.search(r'\[(gateway|heartbeat|XiaoAI Cloud)\].*?(ready|started|已注册)', line)
            if match:
                print('日志：' + match.group(1) + ' ' + match.group(2))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4 or sys.argv[1] not in ('install', 'update'):
            raise DeployError('用法：deploy.py install|update source main')
        deploy(sys.argv[1])
    except (DeployError, OSError, ValueError, KeyError) as error:
        print(str(error) if isinstance(error, DeployError) else '部署配置读取或保存失败；未输出可能含密钥的数据。', file=sys.stderr)
        sys.exit(1)
