import html
from typing import Literal

import streamlit as st

def align(content: str, direction: Literal['right', 'center'], nowrap=False, unsafe_allow_html=False):
    st.markdown(f'<div style="text-align: {direction}; width: 100%; {"white-space: nowrap;" if nowrap else ""}">'
                f'{content if unsafe_allow_html else html.escape(content)}</div>',
                unsafe_allow_html=True)
