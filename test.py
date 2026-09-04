# pyrefly: ignore [missing-import]
from transformers import pipeline

pipe = pipeline("text-generation", model="zai-org/GLM-5.1")
messages = [
    {"role": "user", "content": "Who are you?"},
]
pipe(messages)