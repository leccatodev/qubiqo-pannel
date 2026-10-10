function nodeTemplate() {
  return {
    'package.json': JSON.stringify({
      name: 'discord-bot',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'discord.js': '^14.14.1' },
    }, null, 2),
    'index.js':
`const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', () => {
  console.log(\`Bot online come \${client.user.tag}\`);
});

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN non trovato nel file .env');
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('Errore login:', err.message);
});
`,
  };
}

function pythonTemplate() {
  return {
    'requirements.txt': 'discord.py\n',
    'main.py':
`import os
import discord

intents = discord.Intents.default()
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f"Bot online come {client.user}")

token = os.environ.get("BOT_TOKEN")

if not token:
    raise RuntimeError("DISCORD_TOKEN non trovato nel file .env")

client.run(token)
`,
  };
}

module.exports = { nodeTemplate, pythonTemplate };
