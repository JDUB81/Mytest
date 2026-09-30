const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const db = openDatabase();
const app = createApp(db);

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; everyone will be signed out when the server restarts.');
}

app.listen(port, () => {
  console.log(`Premier Homes CRM running at http://localhost:${port}`);
});
