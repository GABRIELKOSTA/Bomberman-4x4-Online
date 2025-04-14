const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const menu = document.getElementById('menu');
const gameDiv = document.getElementById('game');
const gameOverDiv = document.getElementById('game-over');
const winnerText = document.getElementById('winner-text');
const playerNameInput = document.getElementById('player-name');

const TILE_SIZE = 40;
const ROWS = 15;
const COLS = 15;

// Carrega assets
const playerImgs = {};
const assetsToLoad = [
    { name: 'player1', src: 'assets/player1.png' },
    { name: 'player2', src: 'assets/player2.png' },
    { name: 'player3', src: 'assets/player3.png' },
    { name: 'player4', src: 'assets/player4.png' },
    { name: 'bomb', src: 'assets/bomb.png' },
    { name: 'explosion', src: 'assets/explosion.png' },
    { name: 'blast_range', src: 'assets/blast_range.png' },
    { name: 'kick', src: 'assets/kick.png' },
    { name: 'bomb_up', src: 'assets/bomb_up.png' },
    { name: 'ground', src: 'assets/ground.png' },
    { name: 'wall', src: 'assets/wall.png' },
    { name: 'block', src: 'assets/block.png' }
];
const sounds = {};
const soundFiles = [
    { name: 'powerup', src: 'assets/powerup.wav' },
    { name: 'kick', src: 'assets/kick.wav' },
    { name: 'explosion', src: 'assets/explosion.wav' },
    { name: 'restart', src: 'assets/restart.wav' },
    { name: 'game_over', src: 'assets/game_over.wav' }
];
let assetsLoaded = 0;

assetsToLoad.forEach(asset => {
    const img = new Image();
    img.src = asset.src;
    img.onload = () => {
        assetsLoaded++;
        playerImgs[asset.name] = img;
        if (assetsLoaded === assetsToLoad.length + soundFiles.length) startGameLogic();
    };
    img.onerror = () => {
        console.log(`Failed to load ${asset.src}, using fallback.`);
        playerImgs[asset.name] = null;
        assetsLoaded++;
        if (assetsLoaded === assetsToLoad.length + soundFiles.length) startGameLogic();
    };
});

soundFiles.forEach(sound => {
    const audio = new Audio(sound.src);
    audio.oncanplaythrough = () => {
        assetsLoaded++;
        sounds[sound.name] = audio;
        if (assetsLoaded === assetsToLoad.length + soundFiles.length) startGameLogic();
    };
    audio.onerror = () => {
        console.log(`Failed to load ${sound.src}, using silence.`);
        sounds[sound.name] = null;
        assetsLoaded++;
        if (assetsLoaded === assetsToLoad.length + soundFiles.length) startGameLogic();
    };
});

// Estado do jogo
let state = { players: {}, walls: [], blocks: [], powerups: [], bombs: [], gameStarted: false, gameOver: false };
let localPlayerId = null;
let selectedPlayer = null;
let prevPowerups = [];
let prevBombs = [];
let kickedBombs = new Set();
let powerupSpawnNotified = false; // Para evitar múltiplos alerts
let bombSpawnNotified = false;

// Conecta ao WebSocket
const ws = new WebSocket(window.location.protocol === 'https:' ? `wss://${window.location.host}` : `ws://${window.location.host}`);
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'state') {
        console.log('Estado recebido do servidor:', data);
        state = data;
        updateMenu();

        // Toca som dos power-ups quando coletados
        for (const prevPowerup of prevPowerups) {
            if (prevPowerup.visible && !state.powerups.some(p => p.x === prevPowerup.x && p.y === prevPowerup.y)) {
                console.log(`Power-up coletado em x:${prevPowerup.x}, y:${prevPowerup.y}`);
                if (sounds.powerup) sounds.powerup.play();
            }
        }

        // Toca sons de bombas
        for (const bomb of state.bombs) {
            if (bomb.kicked && !kickedBombs.has(bomb.id)) {
                console.log(`Bomba chutada, ID:${bomb.id}`);
                if (sounds.kick) sounds.kick.play();
                kickedBombs.add(bomb.id);
            }
            if (bomb.exploded && !prevBombs.some(b => b.id === bomb.id && b.exploded)) {
                console.log(`Bomba explodiu, ID:${bomb.id}`);
                if (sounds.explosion) sounds.explosion.play();
            }
        }

        // Limpa bombas que não existem mais do conjunto kickedBombs
        const currentBombIds = new Set(state.bombs.map(b => b.id));
        for (const bombId of kickedBombs) {
            if (!currentBombIds.has(bombId)) {
                kickedBombs.delete(bombId);
            }
        }

        // Notificações visuais
        if (state.blocksClearedTime !== null && (state.gameTime - state.blocksClearedTime) >= 30 * 60 && !powerupSpawnNotified) {
            alert('Todos os blocos foram destruídos! Power-ups de alcance estão spawnando!');
            powerupSpawnNotified = true;
        }
        if (state.gameTime >= 90 * 60 && !bombSpawnNotified) {
            alert('Tempo limite atingido! Bombas aleatórias estão spawnando!');
            bombSpawnNotified = true;
        }

        prevPowerups = [...state.powerups];
        prevBombs = [...state.bombs];
    } else if (data.type === 'game_over') {
        console.log('Jogo terminou:', data);
        state.gameOver = true;
        winnerText.textContent = data.winner ? `${data.winner} venceu!` : 'Empate!';
        gameDiv.style.display = 'none';
        gameOverDiv.style.display = 'block';
        if (sounds.game_over) sounds.game_over.play();
    }
};

// Atualiza a tela inicial
function updateMenu() {
    for (let i = 1; i <= 4; i++) {
        const slot = document.getElementById(`player-${i}`);
        const player = state.players[i];
        if (player) {
            slot.textContent = `Player ${i}: ${player.name} (${player.id === localPlayerId ? 'Você' : 'Pronto'})`;
        } else {
            slot.textContent = `Player ${i}: ${selectedPlayer === i ? 'Editando' : 'Aguardando'}`;
        }
    }
}

// Escolhe um jogador
function choosePlayer(playerId) {
    const name = playerNameInput.value.trim();
    if (!name) {
        alert('Digite seu nome!');
        return;
    }
    selectedPlayer = playerId;
    localPlayerId = playerId;
    ws.send(JSON.stringify({ type: 'choose_player', player_id: playerId, name }));
    playerNameInput.value = '';
    console.log(`Jogador escolhido: Player ${playerId}, Nome: ${name}`);
}

// Inicia o jogo
function startGame() {
    if (Object.keys(state.players).length >= 2) {
        ws.send(JSON.stringify({ type: 'start_game' }));
    } else {
        alert('Precisa de pelo menos 2 jogadores para começar!');
    }
}

// Reinicia o jogo
function restartGame() {
    if (sounds.game_over) sounds.game_over.pause();
    if (sounds.game_over) sounds.game_over.currentTime = 0;
    if (sounds.restart) sounds.restart.play();
    state = { players: {}, walls: [], blocks: [], powerups: [], bombs: [], gameStarted: false, gameOver: false };
    localPlayerId = null;
    selectedPlayer = null;
    kickedBombs.clear();
    powerupSpawnNotified = false;
    bombSpawnNotified = false;
    gameOverDiv.style.display = 'none';
    menu.style.display = 'block';
    for (let i = 1; i <= 4; i++) {
        document.getElementById(`player${i}-hud`).style.display = 'none';
    }
    ws.send(JSON.stringify({ type: 'restart_game' }));
    alert('Jogo reiniciado! Escolha um jogador para começar novamente.');
}

// Sai do jogo
function exitGame() {
    window.close();
}

// Atualiza os HUDs dos jogadores
function updatePlayerHUDs() {
    for (let i = 1; i <= 4; i++) {
        const hud = document.getElementById(`player${i}-hud`);
        const player = state.players[i];
        if (player) {
            hud.style.display = 'block';
            hud.innerHTML = `
                <p>${player.name}</p>
                <p>Alcance: ${player.blast_range}</p>
                <p>Bombas: ${player.max_bombs}</p>
                <p>Chute: ${player.can_kick ? 'Sim' : 'Não'}</p>
            `;
        } else {
            hud.style.display = 'none';
        }
    }
}

// Lógica principal do jogo
function startGameLogic() {
    canvas.setAttribute('tabindex', '0');
    canvas.focus();

    function draw() {
        if (!state.gameStarted) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (playerImgs.ground) {
            for (let row = 0; row < ROWS; row++) {
                for (let col = 0; col < COLS; col++) {
                    ctx.drawImage(playerImgs.ground, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                }
            }
        } else {
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        for (const wall of state.walls) {
            if (playerImgs.wall) {
                ctx.drawImage(playerImgs.wall, wall[0], wall[1], TILE_SIZE, TILE_SIZE);
            } else {
                ctx.fillStyle = 'gray';
                ctx.fillRect(wall[0], wall[1], wall[2], wall[3]);
            }
        }

        for (const block of state.blocks) {
            if (playerImgs.block) {
                ctx.drawImage(playerImgs.block, block[0], block[1], TILE_SIZE, TILE_SIZE);
            } else {
                ctx.fillStyle = 'white';
                ctx.fillRect(block[0], block[1], wall[2], wall[3]);
            }
        }

        for (const powerup of state.powerups) {
            if (powerup.visible) {
                const img = playerImgs[powerup.type];
                const colors = { blast_range: 'blue', kick: 'yellow', bomb_up: 'purple' };
                if (img) {
                    ctx.drawImage(img, powerup.rect[0], powerup.rect[1], TILE_SIZE, TILE_SIZE);
                } else {
                    ctx.fillStyle = colors[powerup.type];
                    ctx.fillRect(powerup.rect[0], powerup.rect[1], TILE_SIZE, TILE_SIZE);
                }
            }
        }

        for (const bomb of state.bombs) {
            if (!bomb.exploded) {
                if (playerImgs.bomb) {
                    ctx.drawImage(playerImgs.bomb, bomb.rect[0], bomb.rect[1], TILE_SIZE, TILE_SIZE);
                } else {
                    ctx.fillStyle = 'red';
                    ctx.fillRect(bomb.rect[0], bomb.rect[1], TILE_SIZE, TILE_SIZE);
                }
            } else {
                for (const area of bomb.explosion_areas) {
                    if (playerImgs.explosion) {
                        ctx.drawImage(playerImgs.explosion, area[0], area[1], TILE_SIZE, TILE_SIZE);
                    } else {
                        ctx.fillStyle = 'orange';
                        ctx.fillRect(area[0], area[1], TILE_SIZE, TILE_SIZE);
                    }
                }
            }
        }

        for (const playerId in state.players) {
            const player = state.players[playerId];
            if (player.alive) {
                const img = playerImgs[`player${playerId}`];
                const colors = { 1: 'green', 2: 'blue', 3: 'red', 4: 'yellow' };
                if (img) {
                    ctx.drawImage(img, player.rect[0], player.rect[1], 35, 35);
                } else {
                    ctx.fillStyle = colors[playerId];
                    ctx.fillRect(player.rect[0], player.rect[1], 35, 35);
                }
                ctx.fillStyle = 'white';
                ctx.font = '16px Arial';
                ctx.fillText(player.name, player.rect[0], player.rect[1] - 10);
            }
        }

        updatePlayerHUDs();
    }

    function gameLoop() {
        if (state.gameStarted && !state.gameOver) {
            menu.style.display = 'none';
            gameDiv.style.display = 'block';
            canvas.focus();
            draw();
        }
        requestAnimationFrame(gameLoop);
    }
    gameLoop();

    document.addEventListener('keydown', (e) => {
        console.log('Tecla pressionada:', e.code);
        console.log('Condições:', {
            gameStarted: state.gameStarted,
            gameOver: !state.gameOver,
            localPlayerId: localPlayerId,
            playerExists: !!state.players[localPlayerId]
        });
        if (state.gameStarted && !state.gameOver && localPlayerId && state.players[localPlayerId]) {
            if (e.code === 'Space') {
                console.log('Colocando bomba');
                ws.send(JSON.stringify({ type: 'place_bomb', player_id: localPlayerId }));
            } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
                const direction = e.code.replace('Arrow', '').toLowerCase();
                console.log('Movendo:', direction);
                ws.send(JSON.stringify({ type: 'move', player_id: localPlayerId, direction }));
            }
        } else {
            console.log('Movimento bloqueado pelas condições');
        }
    });

    document.addEventListener('keyup', (e) => {
        console.log('Tecla solta:', e.code);
        if (state.gameStarted && !state.gameOver && localPlayerId && state.players[localPlayerId]) {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
                console.log('Resetando movimento');
                ws.send(JSON.stringify({ type: 'reset_moving', player_id: localPlayerId }));
            }
        }
    });

    canvas.addEventListener('click', () => {
        canvas.focus();
        console.log('Canvas recebeu foco');
    });
}