import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    texts = payload.get('texts', [])
    model_name = payload.get('model', 'all-MiniLM-L6-v2')

    from sentence_transformers import SentenceTransformer  # type: ignore

    model = SentenceTransformer(model_name)
    vectors = model.encode(texts, normalize_embeddings=True).tolist()
    json.dump({'vectors': vectors}, sys.stdout)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())