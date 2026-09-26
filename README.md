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

## Run locally

    npm install
    DATABASE_URL=postgres://… PORT=8080 npm start

Deployed to Freepod with `freepod deploy`; the schema is created at startup.
