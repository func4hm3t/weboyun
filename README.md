# İHATA

Paper.io style territory game with offline bots and real-time WebSocket multiplayer.

## GitHub Pages

GitHub Pages only serves static files. It cannot run `server.js`.

For multiplayer, host `server.js` on a Node-capable service such as Render, Railway, Fly.io, or a VPS. Then set the hosted WebSocket URL in `index.html`:

```html
<script>
  window.IHATA_WS_URL = 'wss://your-ihata-server.example.com';
</script>
```

You can also test by adding the server URL to the page:

```text
https://your-user.github.io/your-repo/?server=wss://your-ihata-server.example.com
```

## Private Rooms

Open the **Private Room** panel on the start screen.

- Same room name + same password = same match. A different room name creates a separate arena.
- The first player creates the room and sets its rules: **max players** (2–16) and whether bots fill empty slots.
- **Browse Rooms** lists all live rooms with player counts; locked rooms show a 🔒 icon.
- In a room, tap the 🔗 button on the in-game badge to copy an invite link (it includes the room name and password).
- Empty private rooms are deleted automatically after 5 minutes.

Invite links prefill the room fields from the URL:

```text
https://your-user.github.io/your-repo/?room=friends&pass=secret&server=wss://your-ihata-server.example.com
```

## Local Test

```bash
npm install
npm start
```

Open `http://localhost:3000` from two browser tabs and enter the same room name and password.
