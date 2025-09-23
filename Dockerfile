FROM ghcr.io/astral-sh/uv:debian

ADD . /app/
WORKDIR /app

RUN uv sync --locked

EXPOSE 8501
CMD ["uv", "run", "streamlit", "run", "milk.py"]
