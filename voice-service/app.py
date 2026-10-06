# -*- coding: utf-8 -*-
"""
李维斯 Lewis - 语音服务
基于 FunASR + Silero VAD + Edge-TTS
提供语音识别(ASR)、语音合成(TTS)、VAD检测 等接口
"""

import io
import os
import re
import threading
import queue
import gc
import time
import json
from pathlib import Path
# 模型与 SDK 配置留在项目数据目录（Electron 可覆盖到用户数据目录）。
_data_root = Path(__file__).resolve().parent.parent / 'data'
os.environ.setdefault('MODELSCOPE_CACHE', str(_data_root / 'models'))
os.environ.setdefault('MODELSCOPE_HOME', str(_data_root / 'modelscope-config'))
os.environ.setdefault('HF_HOME', str(_data_root / 'huggingface'))
import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify, send_file, Response
import edge_tts
import torch
import torchaudio

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 8 * 1024 * 1024
# 前端统一经过 Node 代理；此服务仅绑定回环地址。

# 配置
CONFIG = {
    "asr_model": "paraformer-zh",  # FunASR中文模型
    "vad_model": "fsmn-vad",        # VAD模型
    "sample_rate": 16000,
    "tts_voice": "zh-CN-XiaoxiaoNeural",  # 微软晓晓，中文女声
    "tts_rate": "+0%",
    "tts_pitch": "+0Hz",
    "tts_volume": "+0%",
}

# 全局模型缓存
_asr_model = None
_vad_model = None
_asr_lock = threading.RLock()
_vad_lock = threading.RLock()
_kws_lock = threading.RLock()
_kws_model = None
_last_asr = 0
_wake_root = Path(os.environ.get('LEWIS_WAKE_MODEL', str(Path(__file__).resolve().parent.parent / 'models' / 'wake')))
RUNTIME = {'wake_engine': 'auto', 'idle_seconds': 120}
_runtime_file = Path(os.environ.get('LEWIS_VOICE_DATA', str(_data_root))) / 'voice-runtime.json'
try:
    saved=json.loads(_runtime_file.read_text(encoding='utf-8'))
    if saved.get('wake_engine') in ['auto','sherpa','legacy'] and type(saved.get('idle_seconds')) is int and 30<=saved['idle_seconds']<=3600 and saved.get('asr_model') in ['paraformer-zh','iic/SenseVoiceSmall']:
        RUNTIME.update({key:saved[key] for key in ['wake_engine','idle_seconds']});CONFIG['asr_model']=saved['asr_model']
except (OSError, ValueError):
    pass


def detect_keyword(audio_data):
    """Small ONNX keyword model runs before FunASR. No full transcription on misses."""
    global _kws_model
    import sherpa_onnx
    with _kws_lock:
        if _kws_model is None:
            def model_file(prefix):
                matches = sorted(_wake_root.glob(prefix + '*.onnx'), key=lambda value: ('int8' not in value.name, value.name))
                if not matches: raise ValueError('轻量唤醒模型缺少 ' + prefix)
                return str(matches[0])
            _kws_model = sherpa_onnx.KeywordSpotter(tokens=str(_wake_root / 'tokens.txt'), encoder=model_file('encoder'), decoder=model_file('decoder'), joiner=model_file('joiner'), keywords_file=str(_wake_root / 'lewis-keywords.txt'), num_threads=1, provider='cpu', keywords_threshold=0.3)
        stream = _kws_model.create_stream()
        stream.accept_waveform(16000, audio_data)
        stream.accept_waveform(16000, np.zeros(10600, dtype=np.float32)); stream.input_finished()
        while _kws_model.is_ready(stream):
            _kws_model.decode_stream(stream)
            if _kws_model.get_result(stream): return True
        return False

def unload_idle(now=None):
    global _asr_model
    with _asr_lock:
        if _asr_model is not None and (now if now is not None else time.monotonic()) - _last_asr >= RUNTIME['idle_seconds']:
            _asr_model = None
            gc.collect()
            if torch.cuda.is_available(): torch.cuda.empty_cache()
            return True
    return False

def idle_cleanup():
    while True:
        time.sleep(15)
        unload_idle()

threading.Thread(target=idle_cleanup, daemon=True).start()

@app.route('/api/runtime', methods=['GET', 'POST'])
def runtime():
    global _asr_model, _kws_model
    if request.method == 'POST':
        value = request.get_json(silent=True) or {}
        if value.get('wake_engine') not in ['auto', 'sherpa', 'legacy'] or type(value.get('idle_seconds')) is not int or not 30 <= value['idle_seconds'] <= 3600 or value.get('asr_model') not in ['paraformer-zh', 'iic/SenseVoiceSmall']:
            return jsonify({'error': '语音运行配置无效'}), 400
        with _asr_lock:
            if CONFIG['asr_model'] != value['asr_model']: _asr_model = None; gc.collect()
            CONFIG['asr_model'] = value['asr_model']; RUNTIME.update({key: value[key] for key in ['wake_engine', 'idle_seconds']})
            _runtime_file.parent.mkdir(parents=True,exist_ok=True)
            temporary=_runtime_file.with_suffix('.tmp');temporary.write_text(json.dumps(value),encoding='utf-8');temporary.replace(_runtime_file)
    return jsonify({**RUNTIME, 'asr_model': CONFIG['asr_model'], 'kws_available': (_wake_root / 'tokens.txt').is_file(), 'kws_loaded': _kws_model is not None, 'asr_loaded': _asr_model is not None})

def get_asr_model():
    """懒加载ASR模型"""
    global _asr_model
    if _asr_model is None:
        print("[ASR] 正在加载语音识别模型 paraformer-zh...")
        from funasr import AutoModel
        _asr_model = AutoModel(
            model=CONFIG['asr_model'],
            vad_model="fsmn-vad",
            punc_model="ct-punc",
            disable_update=True,
            disable_pbar=True,
        )
        print("[ASR] 模型加载完成！")
    return _asr_model

def recognize_audio(audio_data):
    """FunASR 支持 16k float32 数组；锁保护懒加载和共享模型推理。"""
    global _last_asr
    with _asr_lock:
        _last_asr = time.monotonic()
        result = get_asr_model().generate(input=audio_data, fs=16000, batch_size_s=60, hotword='李维斯', disable_pbar=True)
        _last_asr = time.monotonic()
    return result[0].get('text', '') if result else ''

def speech_segments(audio_data):
    """真正的 Silero VAD，不使用音量阈值冒充语音识别。"""
    global _vad_model
    from silero_vad import load_silero_vad, get_speech_timestamps
    with _vad_lock:
        if _vad_model is None:
            _vad_model = load_silero_vad()
        return get_speech_timestamps(torch.from_numpy(audio_data), _vad_model,
                                    sampling_rate=16000, return_seconds=True,
                                    min_speech_duration_ms=150)

@app.errorhandler(413)
def too_large(_error):
    return jsonify({'error': '录音文件超过 8MB', 'success': False}), 413

@app.errorhandler(ValueError)
def invalid_input(error):
    return jsonify({'error': str(error), 'success': False}), 400

def uploaded_audio():
    if 'audio' not in request.files:
        raise ValueError('没有上传 audio 音频文件')
    return load_audio_from_bytes(request.files['audio'].read())

def load_audio_from_bytes(audio_bytes):
    """从字节加载音频，统一转成16k单声道"""
    audio_file = io.BytesIO(audio_bytes)
    try:
        info = sf.info(audio_file)
        if info.duration > 60 or info.frames == 0:
            raise ValueError('录音应为 0–60 秒')
        audio_file.seek(0)
        data, sr = sf.read(audio_file, dtype='float32')
    except (RuntimeError, sf.LibsndfileError) as error:
        raise ValueError('无法解码音频，请上传 PCM WAV') from error
    if not np.isfinite(data).all():
        raise ValueError('音频包含无效样本')
    
    # 转单声道
    if len(data.shape) > 1:
        data = data.mean(axis=1)
    
    # 重采样到16k
    if sr != CONFIG["sample_rate"]:
        waveform = torch.from_numpy(data).float().unsqueeze(0)
        resampler = torchaudio.transforms.Resample(sr, CONFIG["sample_rate"])
        waveform = resampler(waveform)
        data = waveform.squeeze(0).numpy()
    
    return data.astype(np.float32), CONFIG["sample_rate"]

@app.route("/api/health", methods=["GET"])
def health():
    """健康检查"""
    return jsonify({
        "status": "ok",
        "service": "Lewis Voice Service",
        "asr": CONFIG["asr_model"],
        "wake_engine": "sherpa" if RUNTIME["wake_engine"] != "legacy" and (_wake_root / "tokens.txt").is_file() else "legacy",
        "idle_seconds": RUNTIME["idle_seconds"],
        "tts": "edge-tts",
        "vad": "silero-vad",
        "asr_loaded": _asr_model is not None,
        "vad_loaded": _vad_model is not None,
    })

@app.route("/api/asr", methods=["POST"])
def asr():
    """上传 WAV，统一为 16k 单声道后交给 FunASR。"""
    try:
        audio_data, sr = uploaded_audio()
        text = recognize_audio(audio_data)
        return jsonify({'text': text, 'duration': len(audio_data) / sr, 'success': True})
    except ValueError as error:
        return invalid_input(error)
    except Exception as error:
        app.logger.exception('ASR failed')
        return jsonify({'error': str(error), 'success': False}), 503

@app.route("/api/tts", methods=["POST"])
def tts():
    """
    语音合成接口
    参数: text (要合成的文字)
    返回音频文件
    """
    try:
        data = request.get_json(silent=True) or request.form
        text = data.get("text", "")
        
        if not isinstance(text, str) or not text.strip():
            return jsonify({"error": "text不能为空"}), 400
        if len(text) > 12000:
            return jsonify({'error': '单次播报最多 12000 字符'}), 400
        
        voice = data.get("voice", CONFIG["tts_voice"])
        rate = data.get("rate", CONFIG["tts_rate"])
        pitch = data.get("pitch", CONFIG["tts_pitch"])
        volume = data.get("volume", CONFIG["tts_volume"])
        
        # 生成音频
        for value, unit, low, high in [(rate, "%", -50, 50), (pitch, "Hz", -50, 50), (volume, "%", -100, 100)]:
            if not isinstance(value, str) or not re.fullmatch(r"[+-]\d{1,3}" + re.escape(unit), value) or not low <= int(value[:-len(unit)]) <= high:
                return jsonify({"success": False, "error": "语音速度、音高或音量无效，请在设置中重新选择"}), 400
        communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
        
        # 保存到内存
        audio_buffer = io.BytesIO()
        async def save_audio():
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_buffer.write(chunk["data"])
        
        import asyncio
        asyncio.run(save_audio())
        
        audio_buffer.seek(0)
        
        return send_file(
            audio_buffer,
            mimetype="audio/mpeg",
            as_attachment=False,
            download_name="tts.mp3"
        )
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/tts-stream", methods=["GET"])
def tts_stream():
    """异步 Edge-TTS 通过有界队列桥接 WSGI，断开连接后终止生产。"""
    text = request.args.get('text', '')
    voice = request.args.get('voice', CONFIG['tts_voice'])
    if not text or len(text) > 12000:
        return jsonify({'error': 'text 应为 1–12000 字符'}), 400
    chunks = queue.Queue(maxsize=16)
    stopped = threading.Event()
    def put(item):
        while not stopped.is_set():
            try:
                chunks.put(item, timeout=0.2)
                return True
            except queue.Full:
                pass
        return False
    def producer():
        import asyncio
        async def stream():
            async for chunk in edge_tts.Communicate(text, voice).stream():
                if stopped.is_set():
                    break
                if chunk['type'] == 'audio' and not put(chunk['data']):
                    break
        try:
            asyncio.run(stream())
        except Exception as error:
            put(error)
        finally:
            put(None)
    def generate():
        worker = threading.Thread(target=producer, daemon=True)
        worker.start()
        try:
            while True:
                chunk = chunks.get(timeout=60)
                if chunk is None:
                    break
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk
        finally:
            stopped.set()
    return Response(generate(), mimetype='audio/mpeg')

@app.route("/api/vad", methods=["POST"])
def vad():
    try:
        audio_data, sr = uploaded_audio()
        segments = speech_segments(audio_data)
        return jsonify({'has_voice': bool(segments), 'segments': segments,
                        'duration': len(audio_data) / sr, 'success': True})
    except ValueError as error:
        return invalid_input(error)
    except Exception as error:
        return jsonify({'error': str(error), 'success': False}), 503

@app.route("/api/wake-probe", methods=["POST"])
def wake_probe():
    """录音过程中只运行本地小模型，命中即反馈；不调用 FunASR 或云端。"""
    try:
        audio_data, _ = uploaded_audio()
        if len(audio_data) > 16000 * 4:
            raise ValueError('唤醒预检测音频最多 4 秒')
        available = RUNTIME['wake_engine'] != 'legacy' and (_wake_root / 'tokens.txt').is_file()
        if not available:
            return jsonify({'success': True, 'available': False, 'detected': False})
        return jsonify({'success': True, 'available': True, 'detected': detect_keyword(audio_data), 'engine': 'sherpa'})
    except ValueError as error:
        return invalid_input(error)
    except Exception:
        # 预检测失败仍可走原来的完整语句唤醒，不关闭用户的麦克风。
        return jsonify({'success': True, 'available': False, 'detected': False})

@app.route("/api/wake-word", methods=["POST"])
def wake_word():
    """Silero过滤静音，sherpa小模型先检测；命中后FunASR提取同句指令。"""
    try:
        audio_data, _ = uploaded_audio()
        if not speech_segments(audio_data):
            return jsonify({'detected': False, 'text': '', 'command': '', 'success': True})
        lightweight = RUNTIME['wake_engine'] == 'sherpa' or RUNTIME['wake_engine'] == 'auto' and (_wake_root / 'tokens.txt').is_file()
        if lightweight and not detect_keyword(audio_data):
            return jsonify({'detected': False, 'text': '', 'command': '', 'success': True, 'engine': 'sherpa'})
        text = recognize_audio(audio_data)
        # 仅归一化唤醒词匹配；映射回原文，避免网址、金额和消息正文丢失标点。
        positions = [index for index, char in enumerate(text)
                     if not re.match(r'[\s，。！？、,.!?]', char)]
        normalized = ''.join(text[index] for index in positions).lower()
        match = re.search(r'(?:(?:嘿|你好|hi|hey))?(李维斯|利维斯|黎维斯|李威斯|路易斯|刘易斯|lewis|levis)', normalized)
        command = (text[positions[match.end() - 1] + 1:]
                   .lstrip(' \t\r\n，,。！？!?、：:').rstrip(' \t\r\n。！？!?')) if match else ''
        return jsonify({'detected': bool(match), 'wake_word': match.group(1) if match else None,
                        'text': text, 'command': command, 'success': True})
    except ValueError as error:
        return invalid_input(error)
    except Exception as error:
        return jsonify({'error': str(error), 'success': False, 'detected': False}), 503

@app.route("/api/volume", methods=["POST"])
def volume():
    value = (request.get_json(silent=True) or {}).get('value')
    if type(value) is not int or not 0 <= value <= 100:
        return jsonify({'error': '音量必须是 0–100 的整数'}), 400
    if os.name != 'nt':
        return jsonify({'error': '电脑音量仅支持 Windows'}), 400
    import comtypes
    comtypes.CoInitialize()
    try:
        from pycaw.pycaw import AudioUtilities
        endpoint = AudioUtilities.GetSpeakers().EndpointVolume
        endpoint.SetMasterVolumeLevelScalar(value / 100, None)
        return jsonify({'success': True, 'value': value})
    except Exception as error:
        return jsonify({'error': str(error)}), 503
    finally:
        comtypes.CoUninitialize()

if __name__ == "__main__":
    print("=" * 50)
    print("  李维斯 Lewis - 语音服务")
    print("  端口: 5001")
    print("=" * 50)
    print()
    print("  接口列表:")
    print("    GET  /api/health      - 健康检查")
    print("    POST /api/asr         - 语音识别")
    print("    POST /api/tts         - 语音合成")
    print("    POST /api/vad         - VAD检测")
    print("    POST /api/wake-word   - 唤醒词检测")
    print()
    print("  提示: 首次调用ASR会自动下载模型，需要几分钟")
    print("=" * 50)
    print()
    
    app.run(host="127.0.0.1", port=int(os.environ.get('VOICE_PORT', '5001')), debug=False)
