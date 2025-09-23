from datetime import date

import pandas as pd
import streamlit as st

from sqlalchemy.sql import text
from streamlit_extras.bottom_container import bottom

from util import align

st.markdown(
    """
    <style>
    #MainMenu {visibility: hidden;}
    </style>
    """,
    unsafe_allow_html=True,
)

buttons = st.container()
table = st.container()

def on_rows_change(session):
    # {'edited_rows': {}, 'added_rows': [{'selected': True, 'item': 'asfdsafasdfas'}], 'deleted_rows': []}
    if st.session_state['editor_df']['added_rows']:
        rows = [{
            'selected': 1 if r.get('selected') else 0,
            'item': str(r.get('item')),
            'created_on': today
        } for r in st.session_state['editor_df']['added_rows']]
        session.execute(
            text('INSERT INTO milk (created_on, selected, item) VALUES (:created_on, :selected, :item)'),
            rows)

    for rid, props in st.session_state['editor_df']['edited_rows'].items():
        rid = int(items.iloc[rid]['id'])
        for k, v in props.items():
            if k == 'selected':
                v = 1 if v else 0  # in sqlite, boolean is 0/1
            session.execute(
                text(f'UPDATE milk set {k} = :v WHERE id = :id'), {'id': rid, 'v': v})

    for idx in st.session_state['editor_df']['deleted_rows']:
        rid = int(items.iloc[idx]['id'])
        session.execute(text('DELETE FROM milk WHERE id = :id'), {'id': rid})

    session.commit()


today = date.today()
conn = st.connection('milk', type='sql', ttl=0)

with buttons:
    st.session_state.setdefault('mode', 'View')
    st.session_state.setdefault('prev_mode', 'View')
    if not st.session_state.mode:
        st.session_state.mode = st.session_state.prev_mode
    else:
        st.session_state.prev_mode = st.session_state.mode

    edit = st.pills(' ', ['View', 'Edit'], key='mode') == 'Edit'

with conn.session as session, table:
    # Initialize database:
    session.execute(text(
        '''
        CREATE TABLE IF NOT EXISTS milk
        (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            created_on DATE    NOT NULL,
            item       VARCHAR NOT NULL,
            selected   BOOLEAN
        );
        '''))
    session.commit()

    items = pd.read_sql_query('''
                              SELECT m1.id, m1.selected, m1.item
                              FROM milk m1
                              JOIN (SELECT MAX(created_on) AS created_on FROM milk) AS m2
                                ON m1.created_on = m2.created_on
                              ORDER BY LOWER(item)''',
                              session.connection())
    items['selected'] = items['selected'].astype(bool)

    st.data_editor(
        disabled=not edit, key=f'editor_df',
        data=items if edit else items[items['selected'] == True],
        column_order=(['selected'] if edit else []) + ['item'],
        hide_index=True, num_rows='dynamic' if edit else 'fixed', on_change=on_rows_change, args=[session],
        column_config={
            'id': st.column_config.NumberColumn(disabled=True, width=1),
            'selected': st.column_config.CheckboxColumn(disabled=False, width=1, default=False),
            'item': st.column_config.TextColumn(disabled=False, width='large', validate="^\\S+.*$", required=True)},
    )

with bottom():
    align('<a href="https://github.com/erikvanzijst/milk">'
          '<img src="https://badgen.net/static/github/code?icon=github">'
          '</a>', 'center', unsafe_allow_html=True)
