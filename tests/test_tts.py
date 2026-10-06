"""额外可选集成检查：不会联网，验证 Edge-TTS 流桥接确实发送音频。"""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('lewis_voice_tts', Path(__file__).parents[1] / 'voice-service/app.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)

class FakeCommunicate:
    def __init__(self, *args, **kwargs):
        pass
    async def stream(self):
        yield {'type': 'audio', 'data': b'ID3-audio'}
        yield {'type': 'WordBoundary', 'text': 'ignored'}

class TTSTests(unittest.TestCase):
    def test_prosody_reaches_edge_and_bad_values_are_rejected(self):
        calls = []
        class Capture(FakeCommunicate):
            def __init__(self, *args, **kwargs):
                calls.append((args, kwargs))
        client = voice.app.test_client()
        with patch.object(voice.edge_tts, 'Communicate', Capture):
            response = client.post('/api/tts', json={'text': '我在听', 'voice': 'zh-CN-XiaoyiNeural', 'rate': '+6%', 'pitch': '-2Hz'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(calls[0][1]['rate'], '+6%')
            self.assertEqual(calls[0][1]['pitch'], '-2Hz')
            self.assertEqual(calls[0][0][1], 'zh-CN-XiaoyiNeural')
            for value in ['fast', '+999%', None]:
                self.assertEqual(client.post('/api/tts', json={'text': 'hello', 'rate': value}).status_code, 400)
            self.assertEqual(len(calls), 1)
    def test_stream_queue(self):
        with patch.object(voice.edge_tts, 'Communicate', FakeCommunicate):
            response = voice.app.test_client().get('/api/tts-stream?text=hello')
            self.assertEqual(response.data, b'ID3-audio')
    def test_form_and_json_audio(self):
        with patch.object(voice.edge_tts, 'Communicate', FakeCommunicate):
            client = voice.app.test_client()
            self.assertEqual(client.post('/api/tts', json={'text': 'hello'}).data, b'ID3-audio')
            self.assertEqual(client.post('/api/tts', data={'text': 'hello'}).data, b'ID3-audio')
