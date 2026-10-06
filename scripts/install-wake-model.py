"""Install official Apache-2.0 Chinese ONNX wake weights; downloads data only."""
from pathlib import Path
import os, shutil, hashlib, json
root=Path(__file__).resolve().parents[1]
os.environ.setdefault('MODELSCOPE_HOME',str(root/'data/modelscope-config'))
os.environ.setdefault('MODELSCOPE_CACHE',str(root/'data/models'))
from modelscope import snapshot_download
repository='pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
download=Path(snapshot_download(repository,cache_dir=str(root/'data/wake-models'),allow_file_pattern=['*int8.onnx','tokens.txt','README.md']))
target=Path(os.environ.get('LEWIS_WAKE_MODEL',str(root/'models/wake')));target.mkdir(parents=True,exist_ok=True)
for file in download.iterdir():
    if file.name.endswith('.onnx') or file.name in ['tokens.txt','README.md']:shutil.copy2(file,target/file.name)
tokens={line.split()[0] for line in (target/'tokens.txt').read_text(encoding='utf-8').splitlines()}
assert all(token in tokens for token in 'l ǐ w éi s ī ì'.split()),'Unexpected model vocabulary'
(target/'lewis-keywords.txt').write_text('l ǐ w éi s ī @李维斯\nl ì w éi s ī @利维斯\n',encoding='utf-8')
(target/'SOURCE.json').write_text(json.dumps({'repository':'https://modelscope.cn/models/'+repository,'license':'Apache-2.0','files':{file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in target.iterdir() if file.name!='SOURCE.json'}},ensure_ascii=False,indent=2),encoding='utf-8')
print(target)
