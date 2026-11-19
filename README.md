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

The app runs behind "Sign in with Freepod" with `"access": "listed"` (`auth` in
`.freepod.json`), so Freepod admits only the deployment's owner and the people on its
access list. Manage the list under **Access** on the Freepod dashboard. Changes take effect
without a redeploy, and added people get an invitation email. Requests from anyone else
never reach the app, so the app does no access checks of its own.

## Run locally

    npm install
    DATABASE_URL=postgres://… PORT=8080 npm start

There is no sign-in locally; every request is served.

Deployed to Freepod with `freepod deploy`; the schema is created at startup.
