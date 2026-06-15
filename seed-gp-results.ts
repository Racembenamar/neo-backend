import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GP_TOURNAMENT_ID = 'a667dac1-2a7a-46c1-80c1-fdbf746c67fd';

// ── Round-Robin match generator (same algorithm as backend) ──────────────────
function getRoundRobinMatches(players: string[]) {
  const list = [...players];
  const n = list.length;
  const matches: { player1Id: string; player2Id: string; round: number }[] = [];
  if (n < 2) return matches;
  const rounds = n - 1;
  const half = n / 2;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const p1 = list[i];
      const p2 = list[n - 1 - i];
      if (p1 && p2) matches.push({ player1Id: p1, player2Id: p2, round: r + 1 });
    }
    list.splice(1, 0, list.pop()!);
  }
  return matches;
}

// ── Standings computer (mirrors backend logic) ────────────────────────────────
function computeStandings(
  participants: { playerId: string; group: string | null }[],
  matches: any[]
) {
  const groups: Record<string, any[]> = {};
  for (const p of participants) {
    if (!p.group) continue;
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push({
      playerId: p.playerId,
      played: 0, wins: 0, losses: 0, points: 0,
      scoresWon: 0, scoresConceded: 0, scoreDiff: 0,
    });
  }

  for (const m of matches) {
    if (m.status !== 'completed' || !m.group) continue;
    const gs = groups[m.group];
    if (!gs) continue;
    const p1 = gs.find((s: any) => s.playerId === m.player1Id);
    const p2 = gs.find((s: any) => s.playerId === m.player2Id);
    if (p1 && p2) {
      p1.played++; p2.played++;
      p1.scoresWon += m.player1Score; p1.scoresConceded += m.player2Score;
      p2.scoresWon += m.player2Score; p2.scoresConceded += m.player1Score;
      if (m.winnerId === m.player1Id) { p1.wins++; p1.points += 3; p2.losses++; }
      else if (m.winnerId === m.player2Id) { p2.wins++; p2.points += 3; p1.losses++; }
      else { p1.points += 1; p2.points += 1; }
    }
  }

  for (const groupName of Object.keys(groups)) {
    for (const s of groups[groupName]) s.scoreDiff = s.scoresWon - s.scoresConceded;
    groups[groupName].sort((a: any, b: any) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.scoreDiff !== a.scoreDiff) return b.scoreDiff - a.scoreDiff;
      return b.scoresWon - a.scoresWon;
    });
  }
  return groups;
}

async function main() {
  console.log('🏆 Seeding g p tournament results (Racem wins all)...\n');

  // ── 1. Find Racem ──────────────────────────────────────────────────────────
  const racem = await prisma.player.findFirst({
    where: { username: { contains: 'racem', mode: 'insensitive' } },
  });
  if (!racem) {
    console.error('❌ Player "racem" not found!');
    return;
  }
  console.log(`✅ Found Racem: ${racem.name} (ID: ${racem.id})`);

  // ── 2. Fetch tournament & verify ──────────────────────────────────────────
  const tournament = await prisma.tournament.findUnique({
    where: { id: GP_TOURNAMENT_ID },
  });
  if (!tournament) { console.error('❌ Tournament not found'); return; }
  console.log(`📋 Tournament: "${tournament.name}" | Format: ${tournament.format} | GroupSize: ${tournament.groupSize}`);

  // ── 3. Check Racem is a participant ───────────────────────────────────────
  const racemParticipant = await prisma.tournamentParticipant.findUnique({
    where: { tournamentId_playerId: { tournamentId: GP_TOURNAMENT_ID, playerId: racem.id } },
  });
  if (!racemParticipant) {
    console.error('❌ Racem is not a participant in this tournament!');
    return;
  }
  console.log(`✅ Racem is in group: ${racemParticipant.group || '(not yet assigned)'}\n`);

  // ── 4. Fetch all pending group matches ─────────────────────────────────────
  const pendingMatches = await prisma.match.findMany({
    where: {
      tournamentId: GP_TOURNAMENT_ID,
      group: { not: null },
      status: 'pending',
    },
    orderBy: [{ group: 'asc' }, { round: 'asc' }, { matchIndex: 'asc' }],
  });

  console.log(`🎯 Found ${pendingMatches.length} pending group matches to seed.\n`);
  if (pendingMatches.length === 0) {
    console.log('ℹ️  No pending matches — checking if KO bracket already exists...');
    const koMatches = await prisma.match.findMany({
      where: { tournamentId: GP_TOURNAMENT_ID, group: null },
    });
    if (koMatches.length > 0) {
      console.log(`✅ KO bracket already has ${koMatches.length} matches. Nothing to do.`);
    } else {
      console.log('⚠️  No KO bracket yet. May need to manually trigger seeding.');
    }
    return;
  }

  // ── 5. Seed results for all pending group matches ──────────────────────────
  let seeded = 0;
  for (const m of pendingMatches) {
    if (!m.player1Id || !m.player2Id) {
      console.log(`  ⚠️  Match ${m.id} (Group ${m.group} R${m.round} M${m.matchIndex}) — missing players, skipping`);
      continue;
    }

    let score1 = 0;
    let score2 = 0;
    let winner = '';

    const racemIsP1 = m.player1Id === racem.id;
    const racemIsP2 = m.player2Id === racem.id;

    if (racemIsP1) {
      score1 = 3; score2 = 0; winner = racem.id;
    } else if (racemIsP2) {
      score1 = 0; score2 = 3; winner = racem.id;
    } else {
      const p1Wins = Math.random() > 0.4;
      if (p1Wins) {
        score1 = Math.floor(Math.random() * 2) + 2;
        score2 = Math.floor(Math.random() * score1);
        winner = m.player1Id;
      } else {
        score2 = Math.floor(Math.random() * 2) + 2;
        score1 = Math.floor(Math.random() * score2);
        winner = m.player2Id;
      }
    }

    await prisma.match.update({
      where: { id: m.id },
      data: { player1Score: score1, player2Score: score2, winnerId: winner, status: 'completed' },
    });

    seeded++;
    if (seeded % 20 === 0) console.log(`  ... seeded ${seeded}/${pendingMatches.length} matches`);
  }
  console.log(`\n✅ Seeded ${seeded} group matches.\n`);

  // ── 6. Compute final standings for each group ──────────────────────────────
  const allParticipants = await prisma.tournamentParticipant.findMany({
    where: { tournamentId: GP_TOURNAMENT_ID, status: 'accepted' },
  });
  const allGroupMatches = await prisma.match.findMany({
    where: { tournamentId: GP_TOURNAMENT_ID, group: { not: null } },
  });
  const standings = computeStandings(allParticipants, allGroupMatches);

  console.log('📊 Group Standings (top 2 advance):');
  const groupNames = Object.keys(standings).sort();
  for (const g of groupNames) {
    const top = standings[g].slice(0, 3);
    const marker = standings[g].some((s: any) => s.playerId === racem.id) ? ' ⭐' : '';
    console.log(`  Group ${g}${marker}: ${top.map((s: any, i: number) => `#${i + 1} ${s.playerId.slice(0, 8)}... (${s.points}pts)`).join(' | ')}`);
  }

  // Show Racem's standing
  const racemGroup = racemParticipant.group;
  if (racemGroup && standings[racemGroup]) {
    const racemRank = standings[racemGroup].findIndex((s: any) => s.playerId === racem.id) + 1;
    const racemStats = standings[racemGroup].find((s: any) => s.playerId === racem.id);
    console.log(`\n🌟 Racem's position in Group ${racemGroup}: #${racemRank} with ${racemStats?.points} points`);
    if (racemRank <= 2) {
      console.log('  ✅ Racem ADVANCES to Knockout Bracket!');
    } else {
      console.log('  ❌ Racem does NOT advance (not in top 2)');
    }
  }

  // ── 7. Seed the Knockout Bracket ───────────────────────────────────────────
  // Delete any existing KO matches first (clean slate)
  const existingKO = await prisma.match.deleteMany({
    where: { tournamentId: GP_TOURNAMENT_ID, group: null },
  });
  if (existingKO.count > 0) console.log(`\n🗑️  Removed ${existingKO.count} old KO matches.`);

  const groupCount = groupNames.length;
  const advancingCount = tournament.advancingCount || 2;
  const W = advancingCount === 2 ? groupCount * 2 : groupCount;
  const knockoutRounds = Math.log2(W);

  console.log(`\n🏆 Building KO Bracket: ${W} players, ${knockoutRounds} rounds`);

  const knockoutMatchesMap: Record<string, any> = {};
  for (let r = 1; r <= knockoutRounds; r++) {
    const matchCountInRound = W / Math.pow(2, r);
    for (let idx = 0; idx < matchCountInRound; idx++) {
      knockoutMatchesMap[`${r}_${idx}`] = {
        tournamentId: GP_TOURNAMENT_ID,
        round: r,
        matchIndex: idx,
        group: null,
        status: 'pending',
        player1Id: null,
        player2Id: null,
        winnerId: null,
        player1Score: 0,
        player2Score: 0,
      };
    }
  }

  // Seed Round 1: Group A winner vs Group B runner-up, Group B winner vs Group A runner-up, etc.
  if (advancingCount === 2) {
    for (let k = 0; k < groupCount / 2; k++) {
      const g1Name = groupNames[k * 2];
      const g2Name = groupNames[k * 2 + 1];
      const g1 = standings[g1Name] || [];
      const g2 = standings[g2Name] || [];

      const matchA = knockoutMatchesMap[`1_${k * 2}`];
      const matchB = knockoutMatchesMap[`1_${k * 2 + 1}`];
      if (matchA) {
        matchA.player1Id = g1[0]?.playerId || null;
        matchA.player2Id = g2[1]?.playerId || null;
      }
      if (matchB) {
        matchB.player1Id = g2[0]?.playerId || null;
        matchB.player2Id = g1[1]?.playerId || null;
      }
      if (g1Name && g2Name) {
        const g1w = g1[0]?.playerId?.slice(0, 6);
        const g2ru = g2[1]?.playerId?.slice(0, 6);
        const g2w = g2[0]?.playerId?.slice(0, 6);
        const g1ru = g1[1]?.playerId?.slice(0, 6);
        console.log(`  Match ${k*2}: ${g1Name}1st(${g1w}) vs ${g2Name}2nd(${g2ru})`);
        console.log(`  Match ${k*2+1}: ${g2Name}1st(${g2w}) vs ${g1Name}2nd(${g1ru})`);
      }
    }
  } else {
    for (let idx = 0; idx < groupCount / 2; idx++) {
      const g1 = standings[groupNames[idx * 2]] || [];
      const g2 = standings[groupNames[idx * 2 + 1]] || [];
      const m = knockoutMatchesMap[`1_${idx}`];
      if (m) { m.player1Id = g1[0]?.playerId || null; m.player2Id = g2[0]?.playerId || null; }
    }
  }

  const koMatchData = Object.values(knockoutMatchesMap);
  await prisma.match.createMany({ data: koMatchData });
  console.log(`\n✅ Created ${koMatchData.length} KO bracket matches!`);

  // Verify Racem is in the KO bracket
  const racemKOMatch = koMatchData.find(
    (m: any) => m.player1Id === racem.id || m.player2Id === racem.id
  );
  if (racemKOMatch) {
    console.log(`\n🎉 RACEM IS IN THE KO BRACKET! (Round 1, Match ${racemKOMatch.matchIndex})`);
  } else {
    console.log('\n⚠️  Racem was NOT placed in KO bracket — check group standings above.');
  }

  // ── 8. Update tournament status ────────────────────────────────────────────
  await prisma.tournament.update({
    where: { id: GP_TOURNAMENT_ID },
    data: { status: 'in_progress' },
  });
  console.log('\n🏁 Tournament status confirmed: in_progress');
  console.log('\n🎊 Done! Refresh the app to see the Knockout Bracket unlocked.');
}

main()
  .catch(e => console.error('❌ Script failed:', e))
  .finally(() => prisma.$disconnect());
