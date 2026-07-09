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

Use the Room Name and Password fields on the start screen.

Players with the same room name and same password join the same arena. A different room name creates a separate arena. If a room was created with a password, players must enter that exact password to join it.

You can prefill the room name from the URL:

```text
https://your-user.github.io/your-repo/?room=friends&server=wss://your-ihata-server.example.com
```

## Local Test

```bash
npm install
npm start
```

Open `http://localhost:3000` from two browser tabs and enter the same room name and password.
