import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionsBitField, Events } from 'discord.js';
import pg from 'pg';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// PostgreSQL接続設定
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// テーブル初期化
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id SERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      win INTEGER DEFAULT 0,
      lose INTEGER DEFAULT 0,
      games INTEGER DEFAULT 0,
      UNIQUE(channel_id, player_name)
    )
  `);
}

// データ取得・保存系ユーティリティ
async function getPlayer(channelId, name) {
  const res = await pool.query(
    'SELECT * FROM records WHERE channel_id = $1 AND player_name = $2',
    [channelId, name]
  );
  return res.rows[0];
}

async function upsertPlayer(channelId, name, win, lose, games) {
  await pool.query(`
    INSERT INTO records (channel_id, player_name, win, lose, games)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (channel_id, player_name)
    DO UPDATE SET win = $3, lose = $4, games = $5
  `, [channelId, name, win, lose, games]);
}

async function incrementPlayer(channelId, name, winAdd, loseAdd, gamesAdd) {
  const player = await getPlayer(channelId, name);
  if (player) {
    await upsertPlayer(channelId, name,
      player.win + winAdd,
      player.lose + loseAdd,
      player.games + gamesAdd
    );
  } else {
    await upsertPlayer(channelId, name, winAdd, loseAdd, gamesAdd);
  }
}

async function deletePlayer(channelId, name) {
  await pool.query('DELETE FROM records WHERE channel_id = $1 AND player_name = $2', [channelId, name]);
}

async function getAllPlayers(channelId) {
  const res = await pool.query('SELECT * FROM records WHERE channel_id = $1', [channelId]);
  return res.rows;
}

// HTTPサーバー（Railway稼働維持用）
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive');
}).listen(PORT);

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('勝敗を加算')
    .addStringOption(opt => opt.setName('name').setDescription('プレイヤー名').setRequired(true))
    .addIntegerOption(opt => opt.setName('win').setDescription('勝ち数').setRequired(true))
    .addIntegerOption(opt => opt.setName('lose').setDescription('負け数').setRequired(true)),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('試合数を1加算（管理者専用）')
    .addStringOption(opt => opt.setName('names').setDescription('半角スペース区切りで複数指定').setRequired(true)),

  new SlashCommandBuilder()
    .setName('set')
    .setDescription('戦績を手動で設定')
    .addStringOption(opt => opt.setName('name').setDescription('プレイヤー名').setRequired(true))
    .addIntegerOption(opt => opt.setName('win').setDescription('勝ち数').setRequired(true))
    .addIntegerOption(opt => opt.setName('lose').setDescription('負け数').setRequired(true))
    .addIntegerOption(opt => opt.setName('games').setDescription('試合数').setRequired(true)),

  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('プレイヤーの戦績を削除（管理者専用）')
    .addStringOption(opt => opt.setName('name').setDescription('プレイヤー名').setRequired(true)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('戦績を表示する')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

async function main() {
  try {
    console.log('📥 スラッシュコマンドを登録中...');
    await initDB();
    await rest.put(
      Routes.applicationGuildCommands(process.env.APPLICATION_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ スラッシュコマンド登録完了！');

    await client.login(process.env.DISCORD_BOT_TOKEN);  // ← ここで await！
  } catch (err) {
    console.error('❌ 起動中にエラーが発生しました:', err);
  }
}

main();  // ← 明示的に呼び出す

// イベント処理
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const channelId = interaction.channelId;

  switch (interaction.commandName) {
    case 'record': {
      const name = interaction.options.getString('name');
      const win = interaction.options.getInteger('win');
      const lose = interaction.options.getInteger('lose');
      await incrementPlayer(channelId, name, win, lose, 0);
      await interaction.reply(`✅ ${name} に勝ち: ${win} / 負け: ${lose} を加算しました`);
      break;
    }

    case 'play': {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '🚫 管理者のみ実行可能です。', ephemeral: true });
        return;
      }

      const names = interaction.options.getString('names').split(/\s+/);
      for (const name of names) {
        await incrementPlayer(channelId, name, 0, 0, 1);
      }

      await interaction.reply(`✅ ${names.join(', ')} の試合数を1加算しました`);
      break;
    }

    case 'set': {
      const name = interaction.options.getString('name');
      const win = interaction.options.getInteger('win');
      const lose = interaction.options.getInteger('lose');
      const games = interaction.options.getInteger('games');
      await upsertPlayer(channelId, name, win, lose, games);
      await interaction.reply(`✅ ${name} の戦績を設定しました: ${win}勝 ${lose}敗 ${games}試合`);
      break;
    }

    case 'delete': {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '🚫 管理者のみ実行可能です。', ephemeral: true });
        return;
      }

      const name = interaction.options.getString('name');
      await deletePlayer(channelId, name);
      await interaction.reply(`🗑️ ${name} の戦績を削除しました`);
      break;
    }

    case 'stats': {
      const rows = await getAllPlayers(channelId);
      if (rows.length === 0) {
        await interaction.reply('📭 データがありません。');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📊 戦績一覧')
        .setColor(0x00AE86);

      for (const row of rows) {
        const rate = row.win + row.lose > 0
          ? Math.round((row.win / (row.win + row.lose)) * 1000) / 10
          : 0;
        embed.addFields({
          name: `👤 ${row.player_name}`,
          value: `🏆 ${row.win} 勝 / 💀 ${row.lose} 敗 / 🎮 ${row.games} 試合 / 📈 勝率: ${rate}%`,
          inline: false
        });
      }

      await interaction.reply({ embeds: [embed] });
      break;
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Bot起動完了: ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
