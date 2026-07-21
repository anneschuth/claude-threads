# Fork install (for live testing — do NOT merge upstream)

Install this fork **from source** on the prod machine (a `bun install -g github:…`
would only run `prepare: husky` and never build `dist/`, leaving a broken bin):

    git clone -b feat/user-attribution git@github.com:bormog/claude-threads.git
    cd claude-threads
    bun install
    bun run build
    bun link            # exposes the `claude-threads` command from this checkout
    # or run directly:  bun run start   /   bun run dev

It reads the same user-level `~/.config/claude-threads/config.yaml`, so the
existing bot config is reused.

**Disable auto-update while testing** so the updater can't respawn onto the
published npm version and clobber the fork:

    # in ~/.config/claude-threads/config.yaml
    autoUpdate:
      enabled: false
