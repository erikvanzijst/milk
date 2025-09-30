import os
from datetime import date

import pandas as pd
import streamlit as st

from sqlalchemy.sql import text
from streamlit_extras.bottom_container import bottom
from streamlit_extras.floating_button import floating_button
from streamlit_javascript import st_javascript

from util import align

cart = None if (cart := st_javascript("""window.parent.location.pathname""")) == 0 else cart.strip('/').split('/')[0]
st.set_page_config(page_title=cart or 'Got milk?', page_icon=':material/grocery:')
st.markdown("""<style>#MainMenu {visibility: hidden;}</style>""", unsafe_allow_html=True)

pills = st.container()
save = st.container()
table = st.container()

today = date.today()
conn = st.connection('milk', type='sql', ttl=0)
st.session_state.setdefault('mode', 'View')
st.session_state.setdefault('prev_mode', 'View')

with pills:
    if not st.session_state.mode:
        st.session_state.mode = st.session_state.prev_mode
    else:
        st.session_state.prev_mode = st.session_state.mode
    edit = st.pills(' ', ['View', 'Edit'], key='mode', label_visibility='collapsed') == 'Edit'

with conn.session as session, table:
    session.execute(text(
        '''
        CREATE TABLE IF NOT EXISTS milk
        (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            cart       VARCHAR NOT NULL,
            created_on DATE    NOT NULL,
            created_by VARCHAR,
            item       VARCHAR NOT NULL,
            selected   BOOLEAN
        );
        '''))
    session.commit()

    items = pd.read_sql_query('''
                              SELECT m1.id, m1.selected, m1.item, m1.created_by
                              FROM milk m1
                              JOIN (SELECT cart, MAX(created_on) AS created_on FROM milk GROUP BY cart) AS m2
                                ON m1.created_on = m2.created_on AND m2.cart = :cart
                              WHERE m1.cart = :cart
                              ORDER BY LOWER(item)''',
                              session.connection(),
                              params={'cart': cart})
    items['selected'] = items['selected'].astype(bool)

if cart is not None:
    updated_df = st.data_editor(
        key=f'editor_df',
        disabled=not edit,
        data=(items if edit else items[items['selected'] == True]).reset_index(),
        column_order=(['selected'] if edit else []) + ['item'],
        hide_index=edit,
        num_rows='dynamic' if edit else 'fixed',
        width='content',
        height=500,
        column_config={
            'id': st.column_config.NumberColumn(disabled=True, width=1),
            'selected': st.column_config.CheckboxColumn(disabled=False, width=85, default=False),
            'item': st.column_config.TextColumn(disabled=False, width='medium', validate="^\\S+.*$", required=True)})

    if edit:
        changes = items.merge(updated_df, on=['id'], how='outer').query('selected_x != selected_y | item_x != item_y')

        with save:
            if floating_button(f'Save ({len(changes)})', disabled=len(changes) == 0,
                               type='primary', icon=':material/save:'):
                # Apply row attribution:
                updated_df.loc[updated_df['id'].isin(changes['id'].unique()), 'created_by'] = \
                    st.context.headers.get(os.environ.get('USER_HEADER', 'X-Auth-Request-Email'))

                with conn.session as session:
                    session.execute(text('DELETE FROM milk WHERE cart = :cart AND created_on >= :today'),
                                    {'cart': cart, 'today': today})
                    rows = [{
                        'cart': cart,
                        'selected': 1 if r.get('selected') else 0,
                        'item': r.get('item'),
                        'created_on': today,
                        'created_by': r.get('created_by')
                    } for _, r in updated_df.iterrows()]
                    session.execute(text('INSERT INTO milk (cart, created_on, selected, item, created_by) '
                                         'VALUES (:cart, :created_on, :selected, :item, :created_by)'),
                                    rows)
                    session.commit()

                st.rerun()


with bottom():
    align('<a href="https://github.com/erikvanzijst/milk">'
          '<img src="https://badgen.net/static/github/code?icon=github">'
          '</a>', 'center', unsafe_allow_html=True)
