import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  AuditLogEvent,
  Events
} from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import express from 'express';

// --- EXPRESS SUNUCUSU ---
const app = express();

// Basit kontrol endpoint’i (UptimeRobot veya Render ping için)
app.get('/', (req, res) => {
  res.send('AvengersGuard is running ✅');
});

// Render otomatik PORT değeri verir (ör: 10000)
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🌐 Web server is running on port ${port}`);
});

// --- SELF-PING (Render uyumasın diye) ---
const selfURL = 'https://aguard.onrender.com';

// Node 18+ sürümlerinde fetch global olarak bulunur, import etmeye gerek yok
// Ancak uyumluluk için kontrol ekliyoruz:
const fetchFn = global.fetch || (await import('node-fetch')).default;

setInterval(() => {
  fetchFn(selfURL)
    .then(() => console.log('🔁 Self-ping başarılı ✅'))
    .catch((err) => console.error('❌ Self-ping hatası:', err.message));
}, 300000); // 5 dakika

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

// -------------------- Config --------------------
const tempVoiceData = new Map(); // userId -> channelId
const specialVoiceChannels = new Set(); // özel oda id'leri
const logChannelId = process.env.LOG_CHANNEL_ID;
const cezaliRoleId = process.env.CEZALI_ROLE_ID;
const kayitsizRoleId = process.env.KAYITSIZ_ROLE_ID;
const erkekRoleId = process.env.ERKEK_ROLE_ID;
const kizRoleId = process.env.KIZ_ROLE_ID;
const muafRoleId = process.env.MUAF_ROLE_ID;
const yetkiliRoles = process.env.YETKILI_ROLE_IDS ? process.env.YETKILI_ROLE_IDS.split(',') : [];
const prefix = '.';



// Uyarı takibi için Map
const userWarnings = new Map();

// : jail sürelerini saklamak için
const jailTimers = new Map();

// : ceza geçmişi (in-memory). Kalıcı depolama yok.
const punishments = new Map(); // key: userId -> value: [punishmentObjects]

// -------------------- Ready --------------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('💎 A V E N G E R S 💎 Geliştiriyor', { type: ActivityType.Watching });
});

// -------------------- Yeni Üye --------------------
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const kayitsizRole = member.guild.roles.cache.get(kayitsizRoleId);
    if (kayitsizRole) await member.roles.add(kayitsizRole).catch(()=>{});
    const sunucuTag = "★";
    await member.setNickname(`${sunucuTag} İsim | Yaş`).catch(()=>{});
  } catch (e) { console.log('guildMemberAdd err', e); }
});

// -------------------- Rol Silme Koruma --------------------
client.on(Events.GuildRoleDelete, async (role) => {
  try {
    const guild = role.guild;
    const cezaliRoleId = process.env.CEZALI_ROLE_ID;
    const logChannelId = process.env.LOG_CHANNEL_ID;

    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleDelete,
    });
    const entry = fetchedLogs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor || executor.bot) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;

    // 🧩 Koruma dışı (izinli) rollerin ID'leri
    const allowedRoles = [
      "1381923007085412452", // Kurucu
    ];

    // Muaf veya izinli roller hariç tut
    if (
      member.roles.cache.has(process.env.MUAF_ROLE_ID) ||
      member.roles.cache.some(r => allowedRoles.includes(r.id))
    ) {
      console.log(`✅ ${member.user.tag} muaf/izinli rolde, işlem atlandı.`);
      return;
    }

    // Rolü yeniden oluştur
    const roleData = {
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions,
      mentionable: role.mentionable,
      position: role.rawPosition,
    };

    const newRole = await guild.roles.create(roleData).catch(() => null);
    if (newRole) console.log(`♻️ Rol geri oluşturuldu: ${newRole.name}`);

    // Sileni cezalıya at
    const jailRole = guild.roles.cache.get(cezaliRoleId);
    if (jailRole && member.manageable) await member.roles.set([jailRole]).catch(() => {});

    // Log mesajı
    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send(
        `🚨 **Rol silindi:** ${role.name}\n👤 **Silen:** ${executor.tag}\n⚖️ **İşlem:** Cezalıya atıldı, rol geri oluşturuldu.`
      );
    }
  } catch (err) {
    console.error("❌ Rol silme koruma hatası:", err);
  }
});


// -------------------- Rol Oluşturma Koruma --------------------
client.on(Events.GuildRoleCreate, async (role) => {
  try {
    const guild = role.guild;
    const cezaliRoleId = process.env.CEZALI_ROLE_ID;
    const logChannelId = process.env.LOG_CHANNEL_ID;

    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleCreate,
    });
    const entry = fetchedLogs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor || executor.bot) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;

    // 🧩 Koruma dışı (izinli) rollerin ID'leri
    const allowedRoles = [
      "1381923007085412452", // Kurucu
    ];

    // Muaf veya izinli roller hariç tut
    if (
      member.roles.cache.has(process.env.MUAF_ROLE_ID) ||
      member.roles.cache.some(r => allowedRoles.includes(r.id))
    ) {
      console.log(`✅ ${member.user.tag} muaf/izinli rolde, rol oluşturmasına izin verildi.`);
      return;
    }

    // Oluşturulan rolü sil
    await role.delete("İzinsiz rol oluşturma engellendi.").catch(() => {});

    // Ceza: oluşturucuyu cezalıya at
    const jailRole = guild.roles.cache.get(cezaliRoleId);
    if (jailRole && member.manageable) await member.roles.set([jailRole]).catch(() => {});

    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send(
        `🚨 **İzinsiz Rol Oluşturma:** ${role.name}\n👤 **Oluşturan:** ${executor.tag}\n⚖️ **İşlem:** Rol silindi, cezalıya atıldı.`
      );
    }
  } catch (err) {
    console.error("❌ Rol oluşturma koruma hatası:", err);
  }
});


// -------------------- Kanal Silme Koruma --------------------
client.on(Events.ChannelDelete, async (channel) => {
  try {
    const guild = channel.guild;
    const cezaliRoleId = process.env.CEZALI_ROLE_ID;
    const logChannelId = process.env.LOG_CHANNEL_ID;

    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.ChannelDelete,
    });
    const entry = fetchedLogs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor || executor.bot) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;

    // 🧩 Koruma dışı (izinli) rollerin ID'leri
    const allowedRoles = [
      "1381923007085412452", // Kurucu
    ];

    // Muaf veya izinli roller hariç tut
    if (
      member.roles.cache.has(process.env.MUAF_ROLE_ID) ||
      member.roles.cache.some(r => allowedRoles.includes(r.id))
    ) {
      console.log(`✅ ${member.user.tag} muaf/izinli rolde, kanal silme işlemi atlandı.`);
      return;
    }

    // Kanalı yeniden oluştur
    await guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId || null,
      permissionOverwrites: channel.permissionOverwrites.cache.map(po => po.toJSON()),
      reason: "Silinen kanal otomatik olarak geri oluşturuldu.",
    }).catch(() => {});

    // Ceza: Sileni cezalıya at
    const jailRole = guild.roles.cache.get(cezaliRoleId);
    if (jailRole && member.manageable) await member.roles.set([jailRole]).catch(() => {});

    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send(
        `🚨 **Kanal silindi:** ${channel.name}\n👤 **Silen:** ${executor.tag}\n⚖️ **İşlem:** Kanal geri oluşturuldu, cezalıya atıldı.`
      );
    }
  } catch (err) {
    console.error("❌ Kanal silme koruma hatası:", err);
  }
});


// -------------------- Kanal Oluşturma Koruma --------------------
client.on(Events.ChannelCreate, async (channel) => {
  try {
    const guild = channel.guild;
    const cezaliRoleId = process.env.CEZALI_ROLE_ID;
    const logChannelId = process.env.LOG_CHANNEL_ID;

    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.ChannelCreate,
    });
    const entry = fetchedLogs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor || executor.bot) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;

    // 🧩 Koruma dışı (izinli) rollerin ID'leri
    const allowedRoles = [
      "1381923007085412452", // Kurucu
    ];

    // Muaf veya izinli roller hariç tut
    if (
      member.roles.cache.has(process.env.MUAF_ROLE_ID) ||
      member.roles.cache.some(r => allowedRoles.includes(r.id))
    ) {
      console.log(`✅ ${member.user.tag} muaf/izinli rolde, kanal oluşturmasına izin verildi.`);
      return;
    }

    // Oluşturulan kanalı sil
    await channel.delete("İzinsiz kanal oluşturma engellendi.").catch(() => {});

    // Ceza: Oluşturanı cezalıya at
    const jailRole = guild.roles.cache.get(cezaliRoleId);
    if (jailRole && member.manageable) await member.roles.set([jailRole]).catch(() => {});

    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel) {
      logChannel.send(
        `🚨 **İzinsiz Kanal Oluşturma:** ${channel.name}\n👤 **Oluşturan:** ${executor.tag}\n⚖️ **İşlem:** Kanal silindi, cezalıya atıldı.`
      );
    }
  } catch (err) {
    console.error("❌ Kanal oluşturma koruma hatası:", err);
  }
});

// -------------------- Yardımcı Fonksiyonlar --------------------
function hasAnyYetkiliRole(member) {
  if(!member) return false;
  if(member.id === member.guild.ownerId) return true;
  if(member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.roles.cache.some(r => yetkiliRoles.includes(r.id));
}

// punishment kaydını ekleyen yardımcı
async function addPunishment(guild, punishedId, punisherId = null, reason = 'Belirtilmedi', durationMs = 0) {
  try {
    const startAt = new Date();
    const endAt = durationMs > 0 ? new Date(startAt.getTime() + durationMs) : null;

    // DM at
    const member = await guild.members.fetch(punishedId).catch(() => null);
    const punisher = punisherId ? await guild.members.fetch(punisherId).catch(() => null) : null;
    const guildName = guild.name || 'Sunucu';
    const punisherStr = punisher ? `<@${punisher.id}>` : 'Sistem / Otomatik';

    // Türkiye saatine göre
    const tzOptions = { timeZone: 'Europe/Istanbul', hour12: false };
    const startStr = startAt.toLocaleString('tr-TR', tzOptions);
    const endStr = endAt ? endAt.toLocaleString('tr-TR', tzOptions) : 'Süresiz / belirtilmedi';

    const dmText = [
      `❗️ Merhabalar 
    Sunucumuzun içinde kurallara uymadığınız için işlem gördünüz.`,
      `Haksız işlem uygulandığını düşünüyorsanız cezalı kanalına yazabilir veya cezalı seste yetkili arkadaşlarımızı bekleyebilirsiniz.\n`,
      `**Sunucu**: *${guildName}*`,
      `**Ceza atan yetkili**: *${punisherStr}*`,
      `**Ceza sebebi**: *${reason}*`,
      `**Ceza süresi**: *${startStr} - ${endStr}*`
    ].join('\n');

    if(member && !member.user.bot) {
      await member.send({ content: dmText }).catch(() => {});
    }

    // Log kanalı
    const logChannel = guild.channels.cache.get(logChannelId);
    if(logChannel) {
      const logMsg = [
        `⚠️ **CEZA**`,
        `Kullanıcı: <@${punishedId}> (${punishedId})`,
        `Cezayı veren: ${punisherStr}`,
        `Sebep: ${reason}`,
        `Başlangıç: ${startStr}`,
        `Bitiş: ${endStr}`
      ].join('\n');
      await logChannel.send({ content: logMsg }).catch(() => {});
    }

    // ceza kaydı objesi
    const rec = {
      userId: punishedId,
      moderatorId: punisherId,
      reason,
      startAt: startAt.toISOString(),
      endAt: endAt ? endAt.toISOString() : null,
      active: true
    };

    // memory store
    if(!punishments.has(punishedId)) punishments.set(punishedId, []);
    punishments.get(punishedId).push(rec);

    return rec;
  } catch (e) {
    console.log('addPunishment err', e);
    return null;
  }
}

// cezalandırma yapan fonksiyon (ör. yetki suiistimali)
async function punishExecutor(guild, executorId, reason = 'Yetkisiz işlem', durationMs = 0) {
  try {
    const execMember = await guild.members.fetch(executorId).catch(() => null);
    if(!execMember) return;
    if(muafRoleId && execMember.roles.cache.has(muafRoleId)) return; // muaf ise atla
    // cezalı role ver
    if(cezaliRoleId) {
      await execMember.roles.set([cezaliRoleId]).catch(() => {});
    }
    // kaydet ve DM/Log at
    await addPunishment(guild, executorId, null, reason, durationMs);
  } catch (e) {
    console.log('punishExecutor err', e);
  }
}
// -------------------- Mesaj Komutları --------------------
client.on(Events.MessageCreate, async (message) => {
  if(!message.guild || message.author.bot) return;
  if(!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/g);
  const cmd = args.shift().toLowerCase();
  const memberHasYetkili = hasAnyYetkiliRole(message.member);

  // hedef kullanıcıyı id veya mention ile al
  let target = null;
  if(args[0]) {
    target = message.mentions.members.first();
    if(!target) {
      try { target = await message.guild.members.fetch(args[0]); } catch(e){ target = null; }
    }
  }

  // -------------------- Kayıt Komutu: .k veya .kayıt --------------------
if (cmd === 'k' || cmd === 'kayıt') {
  if (!memberHasYetkili) return message.reply('Yetkin yok.');
  if (!args[0]) return message.reply('Kullanıcı ID veya mention girin. Örn: .k <id> İsim Yaş');
  if (!target) return message.reply('Kullanıcı bulunamadı.');
  const isim = args[1] || target.user.username;
  const yas = args[2] || 'Yaş';

  // Butonlu erkek/kız kayıt sistemi
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`k_reg_erkek_${target.id}_${isim}_${yas}`)
      .setLabel('Erkek')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`k_reg_kiz_${target.id}_${isim}_${yas}`)
      .setLabel('Kız')
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await message.channel.send({
    content: `${target} için cinsiyet seçin (isim: ${isim} | yaş: ${yas})`,
    components: [row],
  });

  const filter = (i) =>
    i.customId.startsWith('k_reg_') && i.user.id === message.author.id;
  const collector = msg.createMessageComponentCollector({
    filter,
    time: 60000,
  });

  collector.on('collect', async (i) => {
    try {
      const parts = i.customId.split('_');
      const which = parts[2];
      const uid = parts[3];
      if (uid !== target.id)
        return i.reply({ content: 'Hedef uyuşmuyor.', ephemeral: true });

      if (which === 'erkek') await target.roles.add(erkekRoleId).catch(() => {});
      if (which === 'kiz') await target.roles.add(kizRoleId).catch(() => {});
      await target.roles.remove(kayitsizRoleId).catch(() => {});
      await target.setNickname(`${isim} | ${yas}`).catch(() => {});

      await i.update({
        content: `${target} başarıyla kayıt edildi!`,
        components: [],
      });
    } catch (e) {
      console.log('kayıt collect err', e);
      if (!i.replied)
        await i.reply({
          content: '❌ Kayıt sırasında hata oluştu.',
          ephemeral: true,
        }).catch(() => {});
    }
  });

  collector.on('end', (collected) => {
    if (collected.size === 0)
      msg.edit({
        content: 'Zaman doldu, kayıt iptal edildi.',
        components: [],
      });
  });
}

// -------------------- İsim Komutu: .isim <id> <isim> <yaş> --------------------
if (cmd === 'isim') {
  if (!memberHasYetkili) return message.reply('Yetkin yok.');
  if (!target) return message.reply('Kullanıcı bulunamadı.');
  const isim = args[1];
  const yas = args[2];

  if (!isim || !yas)
    return message.reply('❌ Doğru kullanım: `.isim <id> <isim> <yaş>`');

  try {
    await target.setNickname(`${isim} | ${yas}`).catch(() => {});
    message.reply(`✅ ${target} kullanıcısının ismi **${isim} | ${yas}** olarak değiştirildi.`);
  } catch (e) {
    console.error('isim komutu hatası:', e);
    message.reply('❌ İsim değiştirilirken bir hata oluştu.');
  }
}

// -------------------- Kayıtsız Komutu: .kayıtsız <id> --------------------
if (cmd === 'kayıtsız') {
  if (!memberHasYetkili) return message.reply('Yetkin yok.');
  if (!target) return message.reply('Kullanıcı bulunamadı.');

  try {
    // Tüm rollerini kaldır ve sadece kayıtsız ver
    const kayitsiz = message.guild.roles.cache.get(kayitsizRoleId);
    if (!kayitsiz) return message.reply('⚠️ Kayıtsız rolü bulunamadı.');

    await target.roles.set([kayitsiz]).catch(() => {});
    await target.setNickname('★ İsim | Yaş').catch(() => {});

    message.reply(`🚫 ${target} kullanıcısı kayıtsıza atıldı.`);
  } catch (e) {
    console.error('kayıtsız komutu hatası:', e);
    message.reply('❌ Kayıtsıza atılırken bir hata oluştu.');
  }
}

  // -------------------- Jail Komutu: Select Menu ile --------------------
  // Kullanım: .jail <id>
  if(cmd === 'jail') {
    if(!memberHasYetkili) return message.reply('Yetkin yok.');
    if(!target) return message.reply('Kullanıcı bulunamadı.');

    // Select menu seçenekleri
    const select = new StringSelectMenuBuilder()
      .setCustomId(`jail_select_${target.id}`)
      .setPlaceholder('Jail süresini seçin...')
      .addOptions([
        { label: '| DİĞER |', value: 'süresiz', description: '*Süresiz*' },
        { label: '| DDK/MDK |', value: '1 hafta', description: '*7 Gün*' },
        { label: '| TACİZ |', value: '3 gün', description: '*3 Gün*' },
        { label: '| AĞIR HAKARET |', value: '1 gün', description: '*1 Gün*' },
        { label: '| KURALLARA UYMAMAK |', value: '12 saat', description: '*12 Saat*' },
        { label: '| KIŞKIRTMA/TROLL |', value: '3 saat', description: '*3 Saat*' }
      ]);

    const row = new ActionRowBuilder().addComponents(select);
    const msg = await message.channel.send({ content: `${target} için jail süresini seçin:`, components: [row] });

    const filter = i => i.customId === `jail_select_${target.id}` && i.user.id === message.author.id;
    const collector = msg.createMessageComponentCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (i) => {
      try {
        const choice = i.values[0];
        let duration = 0;
        switch(choice) {
          case 'süresiz': duration = 0; break;
          case '1 hafta': duration = 7*24*60*60*1000; break;
          case '3 gün': duration = 3*24*60*60*1000; break;
          case '1 gün': duration = 24*60*60*1000; break;
          case '12 saat': duration = 12*60*60*1000; break;
          case '3 saat': duration = 3*60*60*1000; break;
          default: duration = 0;
        }

        // uygulama: cezalı role ver
        await target.roles.set([cezaliRoleId]).catch(()=>{});
        await i.update({ content: `${target} *Cezalıya atıldı*. 
    ✅ *Süre* = ${choice}`, components: [] });

        // ceza kaydı ekle (punisher = işlem yapan message.author)
        await addPunishment(message.guild, target.id, message.author.id, `Jail: ${choice}`, duration);

        // zamanlayıcı - süre dolunca güncel üyeyi çekip kayıtsıza çevir ve ceza kaydını pasif yap
        if(duration > 0) {
          if(jailTimers.has(target.id)) clearTimeout(jailTimers.get(target.id));
          const timeout = setTimeout(async () => {
            try {
              const g = msg.guild;
              const fresh = await g.members.fetch(target.id).catch(()=>null);
              if(fresh && fresh.roles.cache.has(cezaliRoleId)) {
                await fresh.roles.set([kayitsizRoleId]).catch(()=>{});
                await fresh.send('Jail süreniz doldu, artık kayıtsızsınız.').catch(()=>{});
              }
              // ceza kaydını pasifleştir
              const arr = punishments.get(target.id) || [];
              for(const p of arr) {
                if(p.active && p.endAt && new Date(p.endAt) <= new Date()) p.active = false;
              }
            } catch(e){ console.log('jail timeout err', e); }
            jailTimers.delete(target.id);
          }, duration);
          jailTimers.set(target.id, timeout);
        }

      } catch(e) {
        console.log('jail collect err', e);
        await i.reply({ content: 'Jail işlemi sırasında hata oluştu.', ephemeral: true });
      }
    });

    collector.on('end', collected => {
      if(collected.size === 0) msg.edit({ content: 'Zaman doldu, jail işlemi iptal edildi.', components: [] });
    });
  }

  // -------------------- Unjail --------------------
  if(cmd === 'unjail') {
    if(!memberHasYetkili) return message.reply('Yetkin yok.');
    if(!target) return message.reply('Kullanıcı bulunamadı.');

    if(jailTimers.has(target.id)) {
      clearTimeout(jailTimers.get(target.id));
      jailTimers.delete(target.id);
    }
    await target.roles.set([kayitsizRoleId]).catch(()=>{});

    // ceza kaydını pasifleştir
    const arr = punishments.get(target.id) || [];
    for(const p of arr) if(p.active) p.active = false;

    message.channel.send(`${target} jailden çıkarıldı ve kayıtsız rol verildi.`);
  }

  // -------------------- Ban / Kick --------------------
  if(cmd === 'ban') {
    if(!memberHasYetkili) return message.reply('Yetkin yok.');
    if(!target) return message.reply('Kullanıcı bulunamadı.');
    const reason = args.slice(1).join(' ') || 'Belirtilmemiş';
    await target.ban({ reason }).catch(()=>{});
    await target.send(`Sunucudan banlandınız. Sebep: ${reason}`).catch(()=>{});
    // kaydet
    await addPunishment(message.guild, target.id, message.author.id, `Ban: ${reason}`, 0);
    message.channel.send(`${target} banlandı.`);
  }

  if(cmd === 'kick') {
    if(!memberHasYetkili) return message.reply('Yetkin yok.');
    if(!target) return message.reply('Kullanıcı bulunamadı.');
    const reason = args.slice(1).join(' ') || 'Belirtilmemiş';
    await target.kick(reason).catch(()=>{});
    await target.send(`Sunucudan atıldınız. Sebep: ${reason}`).catch(()=>{});
    await addPunishment(message.guild, target.id, message.author.id, `Kick: ${reason}`, 0);
    message.channel.send(`${target} sunucudan atıldı.`);
  }

  // -------------------- Voice join / leave --------------------
  if(cmd === 'katıl') {
    if(!message.member.voice.channel) return message.reply('Ses kanalında olmalısın.');
    joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
    message.channel.send('Bot ses kanalına katıldı.');
  }

  if(cmd === 'çık') {
    const connection = getVoiceConnection(message.guild.id);
    if(connection) connection.destroy();
    message.channel.send('Bot ses kanalından ayrıldı.');
  }

  // -------------------- Duyuru DM --------------------
  if(cmd === 'duyurudm') {
    if(!memberHasYetkili) return message.reply('Yetkin yok.');
    const text = args.join(' ');
    if(!text) return message.reply('Mesaj girin.');
    message.guild.members.cache.forEach(member => {
      if(!member.user.bot) member.send(text).catch(()=>{});
    });
    message.channel.send('Duyuru DM olarak gönderildi.');
  }

  // -------------------- Cezalar Görüntüleme --------------------
  // .cezalar  => kendi cezalarını (aktif olanlar) listeler
  // .cezalar <id|mention> => belirtilen kişinin cezalarını listeler
  if(cmd === 'cezalar') {
    let lookupId = message.author.id;
    if(args[0]) {
      const mention = message.mentions.members.first();
      if(mention) lookupId = mention.id;
      else lookupId = args[0];
    }
    const arr = punishments.get(lookupId) || [];
    if(arr.length === 0) {
      if(lookupId === message.author.id) return message.reply('Şu anda kayıtlı cezanız yok.');
      return message.reply('Bu kullanıcıya ait ceza kaydı bulunamadı.');
    }

    // formatla
    const lines = arr.slice().reverse().map(p => {
      const activeStr = p.active ? '✅ Aktif ceza' : '❌ Pasif ceza';
      const endStr = p.endAt ? p.endAt : 'Süresiz';
      return `• ${activeStr} | **Sebep**: ${p.reason} 
      | **Başlangıç**: ${p.startAt} 
      | **Bitiş**: ${endStr}`;
    }).slice(0, 12); // uzun mesajları kes

    const header = lookupId === message.author.id ? 'Kendi ceza geçmişin:' : `${lookupId} kullanıcısının ceza geçmişi:`;
    return message.channel.send(`${header}\n${lines.join('\n')}`);
  }
});

// -------------------- Yasaklı Kelime Guard --------------------
client.on(Events.MessageCreate, async message => {
  if(message.author.bot) return;
  const yasakli = ['.gg','/gg','sunucumuza','allahını','peygamberini','kitabını','kuranını','discord.gg','Muhammedini'];
  if(yasakli.some(word => message.content.toLowerCase().includes(word))) {
    const member = message.member;
    if(!member) return;
    if(member.roles.cache.has(muafRoleId)) return;
    try {
      if(cezaliRoleId) await member.roles.set([cezaliRoleId]).catch(()=>{});
      // ceza kaydı ekle
      await addPunishment(message.guild, member.id, null, 'Yasaklı kelime kullanımı', 0);
    } catch { }
    message.delete().catch(()=>{});
    const logChannel = message.guild.channels.cache.get(logChannelId);
    if(logChannel) logChannel.send(`${message.author.tag} yasaklı kelime kullandı ve cezalandırıldı.`);
  }
});

// AVENGERS SPECİAL 
// -------------------- SETUP KOMUTU --------------------
client.on(Events.MessageCreate, async (message) => {
  if (!message.content.startsWith(".setupv1")) return;
  if (!message.member.roles.cache.has(process.env.MUAF_ROLE_ID))
    return message.reply("❌ Bu komutu sadece muaf rol kullanabilir.");

  try {
    // Kategori oluştur
    const category = await message.guild.channels.create({
      name: "AVENGERS",
      type: ChannelType.GuildCategory
    });

    // Metin kanalı
    const textChannel = await message.guild.channels.create({
      name: "🗽avengers-special",
      type: ChannelType.GuildText,
      parent: category.id
    });

    // Sesli kanal
    const voiceChannel = await message.guild.channels.create({
      name: "🚪 Avengers Kanal Oluşturma",
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: 0
    });

    const embed = new EmbedBuilder()
      .setColor("#f30404")
      .setTitle("⛩️ **Avengers Special**")
      .setDescription(
        "Bu arayüz **özel sesli odaları yönetmek** için kullanılır.\n" +
          "Butonları kullanarak odanızı düzenleyebilirsiniz.\n\n" +
          "**BUTONLAR:**\n" +
          "🔒 Odayı Kilitle\n" +
          "🔓 Kilidi Kaldır\n" +
          "🔢 Oda Sayısı (limit)\n" +
          "💭 Oda Adı Değiştir\n" +
          "👑 Sahipliği Aktar\n" +
          "✅ Oda İzinli (belli kişiye izin)\n" +
          "⛔ Oda Yasaklı (belli kişiyi engelle)\n\n" +
          "_System by **Elyn**_"
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("lock").setLabel("Odayı Kilitle").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("unlock").setLabel("Kilidi Kaldır").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("limit").setLabel("Oda Sayısı").setEmoji("🔢").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rename").setLabel("Oda Adı Değiştir").setEmoji("💭").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("transfer").setLabel("Sahipliği Aktar").setEmoji("👑").setStyle(ButtonStyle.Success)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("allow").setLabel("Oda İzinli").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("block").setLabel("Oda Yasaklı").setEmoji("⛔").setStyle(ButtonStyle.Danger)
    );

    await textChannel.send({ embeds: [embed], components: [row1, row2] });

    message.reply(`✅ Avengers Special sistemi kuruldu!\n📢 Sesli kanal: ${voiceChannel}\n💬 Metin kanalı: ${textChannel}`);
  } catch (err) {
    console.error("Kurulum hatası:", err);
    message.reply("❌ Kurulum sırasında bir hata oluştu.");
  }
});

// -------------------- VOICE STATE --------------------
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guild = newState.guild;
    const user = newState.member;

    // === 1️⃣ Kullanıcı özel oda oluşturma odasına girdiyse ===
    const joinChannel = newState.channel;
    if (joinChannel && joinChannel.name.includes("Avengers Kanal Oluşturma")) {
      // Önceden kayıt varsa ama kanal yoksa temizle
      if (tempVoiceData.has(user.id)) {
        const oldId = tempVoiceData.get(user.id);
        const oldCh = guild.channels.cache.get(oldId);
        if (!oldCh || oldCh.deleted) {
          tempVoiceData.delete(user.id);
          specialVoiceChannels.delete(oldId);
        } else {
          return; // zaten aktif odası varsa yeniden oluşturma
        }
      }

      // Oda oluştur (hemen)
      const privateChannel = await guild.channels.create({
        name: `🔊 ${user.user.username}'s Room`,
        type: ChannelType.GuildVoice,
        parent: joinChannel.parentId,
        permissionOverwrites: [
          { id: user.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels] },
          { id: guild.id, deny: [PermissionsBitField.Flags.Connect] }
        ]
      });

      tempVoiceData.set(user.id, privateChannel.id);
      specialVoiceChannels.add(privateChannel.id);

      // Kullanıcıyı hemen yeni odaya taşı
      if (user.voice.channelId === joinChannel.id) {
        await user.voice.setChannel(privateChannel).catch(() => {});
      }

      console.log(`✅ ${user.user.tag} için özel oda oluşturuldu: ${privateChannel.name}`);
    }

    // === 2️⃣ Kullanıcı özel odadan ayrıldıysa ===
    const leftChannel = oldState.channel;
    if (leftChannel && specialVoiceChannels.has(leftChannel.id)) {
      // Boşsa hemen sil
      if (leftChannel.members.size === 0) {
        const ownerId = [...tempVoiceData.entries()].find(([uid, cid]) => cid === leftChannel.id)?.[0];
        await leftChannel.delete().catch(() => {});
        if (ownerId) tempVoiceData.delete(ownerId);
        specialVoiceChannels.delete(leftChannel.id);
        console.log(`🗑️ ${leftChannel.name} silindi (boş kaldı).`);
      } else {
        // Oda boş değilse ama sahibi çıktıysa sahipliği devret
        const oldOwnerId = [...tempVoiceData.entries()].find(([uid, cid]) => cid === leftChannel.id)?.[0];
        if (oldOwnerId && !leftChannel.members.has(oldOwnerId)) {
          const newOwner = leftChannel.members.first();
          if (newOwner) {
            tempVoiceData.delete(oldOwnerId);
            tempVoiceData.set(newOwner.id, leftChannel.id);
            newOwner.send(`👑 Artık **${leftChannel.name}** odasının yeni sahibisin!`).catch(() => {});
            console.log(`${leftChannel.name} odasının sahipliği ${newOwner.user.tag}'e geçti.`);
          }
        }
      }
    }
  } catch (err) {
    console.error("VoiceStateUpdate hatası:", err);
  }
});

// -------------------- BUTTON + MODAL --------------------
client.on(Events.InteractionCreate, async (interaction) => {
  // Sadece buton veya modal eventlerini dinle
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // 🔒 Özel oda sistemine ait buton ve modal ID'leri
  const privateIds = [
    "lock", "unlock", "limit", "rename", "transfer",
    "allow", "block",
    "limitModal", "renameModal", "transferModal",
    "allowModal", "blockModal"
  ];

  // Eğer interaction özel oda sistemine ait değilse (örneğin .k komutundaki butonlar)
  if (!privateIds.includes(interaction.customId)) return;

  // 🔐 Buradan sonrası sadece özel oda sistemi için
  const userId = interaction.user.id;
  const channelId = tempVoiceData.get(userId);
  const channel = interaction.guild.channels.cache.get(channelId);

  // Kullanıcının özel odası yoksa uyarı gönder
  if (!channel) {
    return interaction.reply({
      content: "❌ Önce bir özel odaya sahip olmalısın.",
      ephemeral: true
    }).catch(() => {});
  }

  // ---- BUTTON ----
  if (interaction.isButton()) {
    const makeModal = (id, title, label, placeholder) => {
      const modal = new ModalBuilder().setCustomId(id).setTitle(title);
      const input = new TextInputBuilder()
        .setCustomId("input")
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return modal;
    };

    switch (interaction.customId) {
      case "lock":
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
        return interaction.reply({ content: "🔒 Oda kilitlendi.", ephemeral: true });

      case "unlock":
        await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: true });
        return interaction.reply({ content: "🔓 Kilit kaldırıldı.", ephemeral: true });

      case "limit":
        return interaction.showModal(makeModal("limitModal", "Oda Kişi Sınırı", "Kişi Sayısı", "Örn: 7"));

      case "rename":
        return interaction.showModal(makeModal("renameModal", "Oda Adı Değiştir", "Yeni Ad", "Örn: Avengers Base"));

      case "transfer":
        return interaction.showModal(makeModal("transferModal", "Sahipliği Aktar", "Kullanıcı ID", "Örn: 123456789"));

      case "allow":
        return interaction.showModal(makeModal("allowModal", "Oda İzinli Ekle", "Kullanıcı ID", "Örn: 123456789"));

      case "block":
        return interaction.showModal(makeModal("blockModal", "Oda Yasaklı Ekle", "Kullanıcı ID", "Örn: 123456789"));
    }
  }

  // ---- MODAL ----
  if (interaction.isModalSubmit()) {
    const value = interaction.fields.getTextInputValue("input");

    switch (interaction.customId) {
      case "limitModal":
        await channel.setUserLimit(Number(value));
        return interaction.reply({ content: `🔢 Oda limiti **${value}** kişi olarak ayarlandı.`, ephemeral: true });

      case "renameModal":
        await channel.setName(value);
        return interaction.reply({ content: `💭 Oda adı **${value}** olarak değiştirildi.`, ephemeral: true });

      case "transferModal":
        tempVoiceData.delete(userId);
        tempVoiceData.set(value, channel.id);
        return interaction.reply({ content: `👑 Sahiplik <@${value}> kullanıcısına aktarıldı.`, ephemeral: true });

      case "allowModal":
        await channel.permissionOverwrites.edit(value, { Connect: true });
        return interaction.reply({ content: `✅ <@${value}> artık odaya girebilir.`, ephemeral: true });

      case "blockModal":
        await channel.permissionOverwrites.edit(value, { Connect: false });
        return interaction.reply({ content: `⛔ <@${value}> artık odaya giremez.`, ephemeral: true });
    }
  }
});

// Mesaj Silme

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(".sil")) return;

  // Yetki kontrolü
  if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
    return message.reply("❌ Bu komutu kullanmak için `Mesajları Yönet` yetkisine sahip olmalısın.");

  const args = message.content.split(" ");
  const amount = parseInt(args[1]);

  if (!amount || amount <= 0)
    return message.reply("❌ Lütfen silinecek mesaj sayısını doğru gir.");

  // Komutu kullanan mesajı da silebiliriz
  await message.delete().catch(() => {});

  try {
    const fetched = await message.channel.messages.fetch({ limit: amount });

    // Bulk delete 14 gün öncesi mesajları atlayacaktır
    const deletable = [];
    const oldMessages = [];

    fetched.forEach(msg => {
      const diff = Date.now() - msg.createdTimestamp;
      if (diff < 14 * 24 * 60 * 60 * 1000) deletable.push(msg); // 14 gün öncesi değilse bulk delete
      else oldMessages.push(msg); // 14 günden eski mesaj
    });

    // Bulk delete
    if (deletable.length > 0) {
      await message.channel.bulkDelete(deletable, true).catch(err => console.log(err));
    }

    // Tek tek sil 14 günden eski mesajları
    for (const msg of oldMessages) {
      await msg.delete().catch(() => {});
    }

    message.channel.send(`✅ ${amount} adet mesaj başarıyla silindi.`)
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
  } catch (err) {
    console.error("Mesaj silme hatası:", err);
    message.channel.send("❌ Mesajlar silinirken bir hata oluştu.");
  }
});

// -------------------- BOT EKLEME KORUMASI --------------------
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!member.user.bot) return; // Gelen kişi bot değilse geç

    const fetchedLogs = await member.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.BotAdd,
    });

    const log = fetchedLogs.entries.first();
    if (!log) return;

    const executor = log.executor;
    const guildMember = await member.guild.members.fetch(executor.id);
    if (guildMember.roles.cache.has(muafRoleId)) return;

    // Rolleri sıfırla ve cezalı ver
    await guildMember.roles.set([]).catch(() => {});
    await guildMember.roles.add(cezaliRoleId).catch(() => {});

    // Log kanalı bildirimi
    const logChannel = member.guild.channels.cache.get(logChannelId);
    if (logChannel) {
      const embed = new EmbedBuilder()
        .setColor('Red')
        .setTitle('🚫 İzinsiz Bot Ekleme!')
        .setDescription(
          `**${executor.tag}** adlı kullanıcı muaf rolü olmadan sunucuya bot ekledi.\n` +
          `**Eklenen Bot:** ${member.user.tag}\n` +
          `Kullanıcının rolleri alındı ve cezalı rol verildi.`
        )
        .setTimestamp();
      logChannel.send({ embeds: [embed] });
    }

  } catch (error) {
    console.error('❌ Bot ekleme korumasında hata:', error);
  }
});


// -------------------- BOT LOGIN --------------------
client.login(process.env.TOKEN);

