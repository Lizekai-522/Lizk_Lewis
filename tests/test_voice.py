import importlib.util
import io
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import soundfile as sf

spec = importlib.util.spec_from_file_location('lewis_voice', Path(__file__).parents[1] / 'voice-service/app.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)

def audio(samples=None, rate=16000):
    buf = io.BytesIO()
    sf.write(buf, samples if samples is not None else np.zeros(rate, dtype=np.float32), rate, format='WAV')
    buf.seek(0)
    return {'audio': (buf, 'test.wav')}

class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.client = voice.app.test_client()
        voice.RUNTIME['wake_engine'] = 'legacy'

    def test_pcm_resampling_and_stereo(self):
        payload = audio(np.zeros((48000, 2), dtype=np.float32), 48000)['audio'][0].getvalue()
        samples, rate = voice.load_audio_from_bytes(payload)
        self.assertEqual(rate, 16000)
        self.assertEqual(samples.shape, (16000,))

    def test_invalid_upload(self):
        for endpoint in ['asr', 'vad', 'wake-word', 'wake-probe']:
            self.assertEqual(self.client.post('/api/' + endpoint).status_code, 400)
            response = self.client.post('/api/' + endpoint, data={'audio': (io.BytesIO(b'bad audio'), 'bad.wav')})
            self.assertEqual(response.status_code, 400)

    def test_asr_model_receives_float32_array(self):
        with patch.object(voice, 'recognize_audio', return_value='您好') as mock:
            response = self.client.post('/api/asr', data=audio())
            self.assertEqual(response.json['text'], '您好')
            self.assertEqual(mock.call_args[0][0].dtype, np.float32)

    def test_real_silero_rejects_silence(self):
        response = self.client.post('/api/vad', data=audio())
        self.assertEqual(response.status_code, 200, response.json)
        self.assertFalse(response.json['has_voice'])

    def test_wake_same_sentence_command_and_normalization(self):
        with patch.object(voice, 'speech_segments', return_value=[{'start': 0, 'end': 1}]), patch.object(voice, 'recognize_audio', return_value='嘿，李维斯，打开计算器。'):
            response = self.client.post('/api/wake-word', data=audio())
            self.assertTrue(response.json['detected'])
            self.assertEqual(response.json['command'], '打开计算器')

    def test_silent_wake_does_not_load_asr(self):
        with patch.object(voice, 'speech_segments', return_value=[]), patch.object(voice, 'recognize_audio') as mock:
            response = self.client.post('/api/wake-word', data=audio())
            self.assertFalse(response.json['detected'])
            mock.assert_not_called()

    def test_wake_preserves_url_decimal_and_message_punctuation(self):
        cases = [
            ('李，维斯，打开网站 https://example.com/a?x=1', '打开网站 https://example.com/a?x=1'),
            ('Hey, Lewis，微信给张三发消息，金额12.50元，今晚 8:30 见。',
             '微信给张三发消息，金额12.50元，今晚 8:30 见'),
        ]
        for transcript, command in cases:
            with self.subTest(transcript=transcript), patch.object(voice, 'speech_segments', return_value=[{}]), patch.object(voice, 'recognize_audio', return_value=transcript):
                response = self.client.post('/api/wake-word', data=audio())
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json['detected'])
                self.assertEqual(response.json['command'], command)

    def test_form_tts_and_limits(self):
        self.assertEqual(self.client.post('/api/tts', data={'text': ''}).status_code, 400)
        self.assertEqual(self.client.post('/api/tts', json={'text': '中' * 12001}).status_code, 400)
        self.assertEqual(self.client.post('/api/volume', json={'value': True}).status_code, 400)

if __name__ == '__main__':
    unittest.main()

class ResourceTests(unittest.TestCase):
    def test_probe_only_uses_keyword_model(self):
        voice.RUNTIME['wake_engine'] = 'sherpa'
        try:
            with patch.object(voice, 'detect_keyword', return_value=True), patch.object(voice, 'recognize_audio') as recognize, patch.object(voice, 'speech_segments') as vad:
                response = voice.app.test_client().post('/api/wake-probe', data=audio())
                self.assertTrue(response.json['detected'])
                self.assertTrue(response.json['available'])
                recognize.assert_not_called(); vad.assert_not_called()
        finally: voice.RUNTIME['wake_engine'] = 'legacy'

    def test_probe_unavailable_and_length_limit(self):
        voice.RUNTIME['wake_engine'] = 'legacy'
        with patch.object(voice, 'recognize_audio') as recognize:
            response = voice.app.test_client().post('/api/wake-probe', data=audio())
            self.assertFalse(response.json['available'])
            response = voice.app.test_client().post('/api/wake-probe', data=audio(np.zeros(16000 * 5)))
            self.assertEqual(response.status_code, 400)
            recognize.assert_not_called()

    def test_keyword_miss_never_loads_asr(self):
        voice.RUNTIME['wake_engine'] = 'sherpa'
        try:
            with patch.object(voice, 'speech_segments', return_value=[{}]), patch.object(voice, 'detect_keyword', return_value=False), patch.object(voice, 'recognize_audio') as recognize:
                response = voice.app.test_client().post('/api/wake-word', data=audio())
                self.assertFalse(response.json['detected']); recognize.assert_not_called()
        finally: voice.RUNTIME['wake_engine'] = 'legacy'
    def test_idle_unload_does_not_unload_active_model(self):
        with patch.object(voice, '_asr_model', object()), patch.object(voice, '_last_asr', 100):
            self.assertFalse(voice.unload_idle(101)); self.assertIsNotNone(voice._asr_model)
            self.assertTrue(voice.unload_idle(1000)); self.assertIsNone(voice._asr_model)
