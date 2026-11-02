import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DeployTests(unittest.TestCase):
    def setUp(self):
        temporary_root = Path(__file__).resolve().parents[4] / 'tmp'
        temporary_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temporary_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entry = self.root / 'compose.yaml'
        self.entry.write_text('original entry')
        self.runtime = self.root / 'runtime/compose.json'
        self.model = {'name': 'openclaw-xiaoai', 'services': {d.SERVICE: {
            'image': 'old:latest', 'environment': {'TOKEN': 'secret', 'LITERAL': '$VALUE'},
            'ports': [{'target': 18789, 'published': '18789', 'host_ip': '127.0.0.1'}],
            'command': ['node', 'dist/index.js', 'gateway', '--bind', 'lan', '--port', '18789'],
            'volumes': [{'type': 'bind', 'source': '/data', 'target': '/home/node/.openclaw'}],
            'networks': {'default': {'aliases': ['gateway']}}}}, 'networks': {'default': {'name': 'original'}}}

    def test_registration_twice_preserves_first_three_exactly(self):
        file = self.root / 'projects.conf'
        original = '# private registry\nminio|MinIO|one\nyklx|Workbench|two\nmigpt|MiGPT|three\n'
        file.write_text(original)
        d.register(file)
        d.register(file)
        self.assertEqual(file.read_text(encoding='utf-8'), original + d.ENTRY + '\n')

    def test_load_model_accepts_inherited_image_healthcheck_without_changing_compose(self):
        model = copy.deepcopy(self.model)
        model['services'][d.SERVICE]['container_name'] = d.CONTAINER
        old = {'Config': {'Labels': {'com.docker.compose.project': 'openclaw-xiaoai',
                                    'com.docker.compose.service': d.SERVICE,
                                    'com.docker.compose.config-hash': 'hash'},
                          'Cmd': model['services'][d.SERVICE]['command'],
                          'Healthcheck': {'Test': ['CMD', 'node', 'dist/docker-healthcheck.js']}},
               'Mounts': [{'Destination': '/home/node/.openclaw', 'Type': 'bind', 'RW': True}]}
        def config(*args):
            return d.SERVICE + ' hash\n' if '--hash' in args else json.dumps(model)
        with patch.object(d, 'compose', side_effect=config):
            self.assertEqual(d.load_model(old), model)
            self.assertNotIn('healthcheck', model['services'][d.SERVICE])
            for health in ({}, {'Test': ['NONE']}):
                old['Config']['Healthcheck'] = health
                with self.assertRaisesRegex(d.DeployError, '健康检查'):
                    d.load_model(old)
            old['Config']['Healthcheck'] = {'Test': ['CMD', 'node', 'health.js']}
            model['services'][d.SERVICE]['healthcheck'] = {'disable': True}
            with self.assertRaisesRegex(d.DeployError, '健康检查'):
                d.load_model(old)

    def test_candidate_preserves_every_service_setting_except_image_and_plugin_overlay(self):
        previous = copy.deepcopy(self.model)
        model = d.candidate_model(previous, 'new:git', Path('/releases/one'))
        service = model['services'][d.SERVICE]
        self.assertEqual(previous, self.model)
        self.assertEqual(service['volumes'][:-1], self.model['services'][d.SERVICE]['volumes'])
        self.assertTrue(service['volumes'][-1]['read_only'])
        service['image'] = 'old:latest'
        service['volumes'].pop()
        self.assertEqual(model, self.model)
        self.assertEqual(d.escape({'e': '$VALUE'}), {'e': '$$VALUE'})

    def test_failed_build_never_stops_old_service(self):
        class Failed:
            returncode = 1
        with patch.object(d, 'ROOT', self.root), patch.object(d.subprocess, 'run', return_value=Failed()), patch.object(d, 'compose') as compose:
            with self.assertRaisesRegex(d.DeployError, '旧服务保持运行'):
                d.build('image', 'digest', 'revision')
            compose.assert_not_called()

    def test_health_wait_allows_maintenance_longer_than_three_minutes(self):
        for check in (d.check_ready, d.check_ready_rollback):
            states = [{'State': {'Running': True, 'Health': {'Status': 'unhealthy'}}}] * 100
            states.append({'State': {'Running': True, 'Health': {'Status': 'healthy'}}})
            with patch.object(d, 'inspect', side_effect=states), patch.object(d.time, 'sleep') as sleep, patch.object(d, 'run'), patch('builtins.print'):
                check()
                self.assertEqual(sleep.call_count, 100)

    def test_health_wait_still_fails_after_ten_minutes(self):
        with patch.object(d, 'inspect', return_value={'State': {'Running': True, 'Health': {'Status': 'unhealthy'}}}), patch.object(d.time, 'sleep') as sleep, patch('builtins.print'):
            with self.assertRaisesRegex(d.DeployError, '10 分钟'):
                d.check_ready()
            self.assertEqual(sleep.call_count, 300)

    def test_health_failure_restores_previous_image_and_settings_without_restoring_data(self):
        backup = self.root / 'backup'
        backup.mkdir()
        d.write_json(backup / 'model.json', self.model)
        calls = []
        old = {'Image': 'sha256:old'}
        candidate = d.candidate_model(self.model, 'new:git', Path('/release'))
        with patch.object(d, 'ENTRY_FILE', self.entry), patch.object(d, 'RUNTIME', self.runtime), patch.object(d, 'compose', side_effect=lambda *a: calls.append(a)), patch.object(d, 'backup_data') as data, patch.object(d, 'check_ready', side_effect=d.DeployError('health failed')), patch.object(d, 'check_ready_rollback') as rollback:
            with self.assertRaisesRegex(d.DeployError, 'health failed'):
                d.switch(old, candidate, backup)
            restored = json.loads(self.runtime.read_text())
            self.assertEqual(restored['services'][d.SERVICE]['image'], 'sha256:old')
            self.assertEqual(restored['services'][d.SERVICE]['volumes'], self.model['services'][d.SERVICE]['volumes'])
            self.assertEqual(calls[0], ('stop', d.SERVICE))
            self.assertEqual(len(calls), 3)
            data.assert_called_once_with(old, backup)
            rollback.assert_called_once()

    def test_success_backup_then_switch_and_health(self):
        backup = self.root / 'backup'
        backup.mkdir()
        d.write_json(backup / 'model.json', self.model)
        order = []
        with patch.object(d, 'ENTRY_FILE', self.entry), patch.object(d, 'RUNTIME', self.runtime), patch.object(d, 'compose', side_effect=lambda *a: order.append(a[0])), patch.object(d, 'backup_data', side_effect=lambda *a: order.append('backup')), patch.object(d, 'check_ready', side_effect=lambda: order.append('health')):
            d.switch({'Image': 'old'}, d.candidate_model(self.model, 'new', Path('/release')), backup)
        self.assertEqual(order, ['stop', 'backup', 'up', 'health'])


if __name__ == '__main__':
    unittest.main()
