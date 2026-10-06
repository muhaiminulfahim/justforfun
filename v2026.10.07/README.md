# Mini Multiplayer Car Game

The game runs in the host's browser. Phones that open an invite link become joystick controllers, and each one adds a car to the host screen.

## Run

```
npm install
npm start
```

Open `http://localhost:3000` on the big screen, then click **👥 Invite players**. A QR code and a link (using your computer's Wi-Fi address) appear. Phones on the same network scan it, tap JOIN, and drive.

## Files

- `index.html`: the game / host screen, with the invite panel
- `controller.html`: the phone joystick (served at `/j/<CODE>`)
- `server.js`: static files, WebSocket rooms, QR endpoint
- `relay-test.js`: smoke test (`PORT=3000 node relay-test.js` while the server runs)

## Notes

- Local players still work: P1 WASD + Shift, P2 arrows + Enter, gamepads, touch joysticks.
- Deploy `server.js` anywhere that runs Node (use HTTPS) and invite links work from any network, not just the same Wi-Fi.
- Up to 12 phones per room. A phone that drops keeps its car for 12 s; reloading the host tab resumes the room.
