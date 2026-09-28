# Milk

A shopping list that remembers everything you ever buy.

- **Shop mode** shows this trip's list in store order. Tap an item to check it off; it stays
  in place, struck through. "Clear checked" takes checked items off the list (with undo).
- **Edit mode** shows the whole catalog: every item you have ever added. Tap to put an item
  on or off the list, type to find or add, drag the grip to match your store's layout, and
  use the trash can to delete an item from the catalog for good.

Order is a floating-point `weight` per item (lower = earlier). Moving an item sets its
weight to the midpoint of its new neighbors; when that gap gets too small the whole
catalog is renumbered in steps of 1024.

## Access

The app runs behind "Sign in with Freepod" (`auth` in `.freepod.json`), which lets any
Freepod account sign in. Only the addresses in `MILK_ALLOWED_EMAILS` (separated by commas
or spaces, case-insensitive) can see or change the list; everyone else gets a "This list is
private" page, and the attempt shows up in `freepod log`. When the var is empty or unset,
nobody gets in.

    freepod var set MILK_ALLOWED_EMAILS="alice@example.com,bob@example.com"

Setting it rolls the deployment, so changes take effect within a minute.

## Run locally

    npm install
    DATABASE_URL=postgres://… PORT=8080 \
      MILK_ALLOWED_EMAILS=dev@example.com MILK_DEV_EMAIL=dev@example.com npm start

There is no Freepod sign-in locally, so `MILK_DEV_EMAIL` stands in for the signed-in user.

Deployed to Freepod with `freepod deploy`; the schema is created at startup.
