const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TILE_SIZE = 40;
const ROWS = 15;
const COLS = 15;

// Estado do jogo
let players = {};
let walls = [];
let blocks = [];
let powerups = [];
let bombs = [];
let gameStarted = false;
let gameOver = false;
let bombIdCounter = 0;
let gameTime = 0;
let blocksClearedTime = null;
let lastPowerupSpawnTime = 0;
let lastBombSpawnTime = 0;

// Gera o mapa
function createMap() {
    walls = [];
    blocks = [];
    powerups = [];
    const powerupTypes = ["blast_range", "kick", "bomb_up"];
    const numPowerups = Math.floor(Math.random() * 6) + 3;
    const powerupPositions = [];

    const protectedAreas = [
        [[1,1], [1,2], [2,1], [2,2], [1,3], [3,1]],
        [[13,1], [13,2], [14,1], [14,2], [13,3], [12,1]],
        [[1,13], [1,14], [2,13], [2,14], [1,12], [3,13]],
        [[13,13], [13,14], [14,13], [14,14], [13,12], [12,13]]
    ].flat();

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            if (row === 0 || row === ROWS - 1 || col === 0 || col === COLS - 1 || (row % 2 === 0 && col % 2 === 0)) {
                walls.push([col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE]);
            } else if (Math.random() < 0.3 && !protectedAreas.some(([r, c]) => r === row && c === col)) {
                const block = [col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE];
                blocks.push(block);
                if (Math.random() < 0.3 && powerupPositions.length < numPowerups) {
                    powerupPositions.push([col * TILE_SIZE, row * TILE_SIZE]);
                }
            }
        }
    }

    for (const [x, y] of powerupPositions) {
        const type = powerupTypes[Math.floor(Math.random() * powerupTypes.length)];
        powerups.push({ x, y, type, rect: [x, y, TILE_SIZE, TILE_SIZE], visible: false });
    }
    console.log(`Mapa criado. Blocos iniciais: ${blocks.length}`);
}

// Verifica colisão entre dois retângulos
function collides(rect1, rect2) {
    return rect1[0] < rect2[0] + rect2[2] &&
           rect1[0] + rect1[2] > rect2[0] &&
           rect1[1] < rect2[1] + rect2[3] &&
           rect1[1] + rect1[3] > rect2[1];
}

// Encontra uma posição válida para spawn
function findValidSpawnPosition() {
    let attempts = 0;
    const maxAttempts = 500; // Aumentado ainda mais
    while (attempts < maxAttempts) {
        const row = Math.floor(Math.random() * ROWS);
        const col = Math.floor(Math.random() * COLS);
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;
        const rect = [x, y, TILE_SIZE, TILE_SIZE];

        // Relaxa as condições: só verifica colisão com paredes
        if (!walls.some(wall => collides(rect, wall))) {
            console.log(`Posição válida encontrada: x:${x}, y:${y}`);
            return { x, y };
        }
        attempts++;
    }
    // Fallback: usa uma posição fixa se não encontrar uma válida
    console.log('Nenhuma posição válida encontrada. Usando posição fixa.');
    return { x: 3 * TILE_SIZE, y: 3 * TILE_SIZE }; // Posição fixa longe das áreas protegidas
}

// WebSocket: Gerencia conexões de clientes
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.type === 'choose_player') {
            const playerId = data.player_id;
            const name = data.name;
            if (!players[playerId] && playerId >= 1 && playerId <= 4) {
                const positions = [[1,1], [13,1], [1,13], [13,13]];
                const [row, col] = positions[playerId - 1];
                players[playerId] = {
                    id: playerId,
                    name: name,
                    alive: true,
                    x: col * TILE_SIZE,
                    y: row * TILE_SIZE,
                    rect: [col * TILE_SIZE, row * TILE_SIZE, 35, 35],
                    bombs: [],
                    moving: false,
                    blast_range: 2,
                    can_kick: false,
                    max_bombs: 1
                };
                ws.playerId = playerId;
                console.log(`Jogador ${playerId} (${name}) conectado`);
                broadcastState();
            }
        } else if (data.type === 'start_game' && !gameStarted) {
            if (Object.keys(players).length >= 2) {
                gameStarted = true;
                gameTime = 0;
                blocksClearedTime = null;
                lastPowerupSpawnTime = 0;
                lastBombSpawnTime = 0;
                createMap();
                console.log('Jogo iniciado');
                broadcastState();
            }
        } else if (data.type === 'restart_game') {
            console.log('Reiniciando o jogo...');
            players = {};
            walls = [];
            blocks = [];
            powerups = [];
            bombs = [];
            gameStarted = false;
            gameOver = false;
            bombIdCounter = 0;
            gameTime = 0;
            blocksClearedTime = null;
            lastPowerupSpawnTime = 0;
            lastBombSpawnTime = 0;
            wss.clients.forEach(client => {
                client.playerId = null;
            });
            broadcastState();
        } else if (data.type === 'move' && gameStarted) {
            console.log('Mensagem de movimento recebida:', data);
            const player = players[ws.playerId];
            if (player && !player.moving && player.alive) {
                const { direction } = data;
                const dx = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
                const dy = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
                const newRect = [...player.rect];
                newRect[0] += dx * TILE_SIZE;
                newRect[1] += dy * TILE_SIZE;

                if (![...walls, ...blocks].some(wall => collides(newRect, wall))) {
                    let canMove = true;
                    for (const bomb of bombs) {
                        if (collides(newRect, bomb.rect) && !bomb.kicked) {
                            if (player.can_kick) {
                                bomb.kicked = true;
                                bomb.kick_dx = dx;
                                bomb.kick_dy = dy;
                                bomb.kick_speed = 4;
                            } else {
                                canMove = false;
                            }
                            break;
                        }
                    }
                    if (canMove) {
                        player.rect = newRect;
                        player.x = newRect[0];
                        player.y = newRect[1];
                        player.moving = true;
                        console.log(`Jogador ${player.id} moveu para x:${player.x}, y:${player.y}`);
                    }
                }
                broadcastState();
            }
        } else if (data.type === 'place_bomb' && gameStarted) {
            const player = players[ws.playerId];
            if (player && bombs.filter(b => b.owner_id === ws.playerId).length < player.max_bombs) {
                const bomb = {
                    id: bombIdCounter++,
                    x: Math.floor(player.x / TILE_SIZE) * TILE_SIZE,
                    y: Math.floor(player.y / TILE_SIZE) * TILE_SIZE,
                    rect: [Math.floor(player.x / TILE_SIZE) * TILE_SIZE, Math.floor(player.y / TILE_SIZE) * TILE_SIZE, TILE_SIZE, TILE_SIZE],
                    timer: 180,
                    exploded: false,
                    explosion_areas: [],
                    blast_range: player.blast_range,
                    kicked: false,
                    kick_dx: 0,
                    kick_dy: 0,
                    kick_speed: 4,
                    owner_id: ws.playerId
                };
                bombs.push(bomb);
                console.log(`Bomba colocada por jogador ${ws.playerId} em x:${bomb.x}, y:${bomb.y}, ID:${bomb.id}`);
                broadcastState();
            }
        } else if (data.type === 'reset_moving' && gameStarted) {
            const player = players[ws.playerId];
            if (player) {
                player.moving = false;
                console.log(`Movimento do jogador ${ws.playerId} resetado`);
                broadcastState();
            }
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            console.log(`Jogador ${ws.playerId} desconectado`);
            delete players[ws.playerId];
            broadcastState();
        }
    });
});

// Atualiza o estado do jogo
setInterval(() => {
    if (gameStarted && !gameOver) {
        gameTime++;
        const alivePlayers = Object.values(players).filter(p => p.alive);
        console.log(`gameTime: ${gameTime} (${(gameTime / 60).toFixed(1)}s), blocks.length: ${blocks.length}, blocksClearedTime: ${blocksClearedTime}, alivePlayers: ${alivePlayers.length}`);

        // Atualiza bombas
        for (let i = bombs.length - 1; i >= 0; i--) {
            const bomb = bombs[i];
            bomb.timer--;
            if (bomb.kicked) {
                const newRect = [...bomb.rect];
                newRect[0] += bomb.kick_dx * bomb.kick_speed;
                newRect[1] += bomb.kick_dy * bomb.kick_speed;
                if ([...walls, ...blocks].some(wall => collides(newRect, wall))) {
                    bomb.kicked = false;
                    bomb.kick_dx = 0;
                    bomb.kick_dy = 0;
                    bomb.rect[0] = Math.round(bomb.rect[0] / TILE_SIZE) * TILE_SIZE;
                    bomb.rect[1] = Math.round(bomb.rect[1] / TILE_SIZE) * TILE_SIZE;
                    bomb.x = bomb.rect[0];
                    bomb.y = bomb.rect[1];
                } else {
                    bomb.rect = newRect;
                    bomb.x = newRect[0];
                    bomb.y = newRect[1];
                }
            }
            if (bomb.timer <= 0 && !bomb.exploded) {
                bomb.exploded = true;
                bomb.explosion_areas = [[bomb.x, bomb.y, TILE_SIZE, TILE_SIZE]];
                const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                for (const [dx, dy] of directions) {
                    for (let j = 1; j <= bomb.blast_range; j++) {
                        const ex = bomb.x + dx * j * TILE_SIZE;
                        const ey = bomb.y + dy * j * TILE_SIZE;
                        const explosionRect = [ex, ey, TILE_SIZE, TILE_SIZE];
                        if (walls.some(wall => collides(explosionRect, wall))) break;
                        bomb.explosion_areas.push(explosionRect);
                        const blockIndex = blocks.findIndex(block => collides(explosionRect, block));
                        if (blockIndex !== -1) {
                            console.log(`Bloco destruído em x:${ex}, y:${ey}. Blocos restantes: ${blocks.length - 1}`);
                            blocks.splice(blockIndex, 1);
                            const powerup = powerups.find(p => collides(p.rect, explosionRect));
                            if (powerup) powerup.visible = true;
                            break;
                        }
                    }
                }
            }
            if (bomb.exploded && bomb.timer <= -60) {
                bombs.splice(i, 1);
            }
        }

        // Verifica colisões de explosão
        for (const playerId in players) {
            const player = players[playerId];
            if (player.alive) {
                for (const bomb of bombs) {
                    if (bomb.exploded) {
                        for (const area of bomb.explosion_areas) {
                            if (collides(player.rect, area)) {
                                player.alive = false;
                                console.log(`Jogador ${playerId} (${player.name}) morreu.`);
                            }
                        }
                    }
                }
            }
        }

        // Coleta power-ups
        for (const playerId in players) {
            const player = players[playerId];
            if (player.alive) {
                for (let i = powerups.length - 1; i >= 0; i--) {
                    const powerup = powerups[i];
                    if (collides(player.rect, powerup.rect) && powerup.visible) {
                        if (powerup.type === 'blast_range') player.blast_range++;
                        else if (powerup.type === 'kick') player.can_kick = true;
                        else if (powerup.type === 'bomb_up') player.max_bombs++;
                        powerups.splice(i, 1);
                        console.log(`Power-up ${powerup.type} coletado por ${player.name}`);
                    }
                }
            }
        }

        // Verifica se todos os blocos foram destruídos
        if (blocks.length === 0 && blocksClearedTime === null) {
            blocksClearedTime = gameTime;
            console.log('Todos os blocos foram destruídos. Iniciando temporizador de 30 segundos.');
        }

        // Após 30 segundos sem blocos, spawna power-ups blast_range
        if (blocksClearedTime !== null && (gameTime - blocksClearedTime) >= 30 * 60) {
            console.log(`Verificando spawn de power-up: alivePlayers: ${alivePlayers.length}, tempo desde último spawn: ${gameTime - lastPowerupSpawnTime}`);
            if (alivePlayers.length > 1) {
                if (gameTime - lastPowerupSpawnTime >= 10 * 60) {
                    const position = findValidSpawnPosition();
                    if (position) {
                        const { x, y } = position;
                        powerups.push({
                            x,
                            y,
                            type: 'blast_range',
                            rect: [x, y, TILE_SIZE, TILE_SIZE],
                            visible: true
                        });
                        console.log(`Power-up blast_range spawnado em x:${x}, y:${y}`);
                        lastPowerupSpawnTime = gameTime;
                    } else {
                        console.log('Falha ao spawnar power-up: posição inválida');
                    }
                }
            } else {
                console.log('Spawn de power-up cancelado: menos de 2 jogadores vivos');
            }
        }

        // Após 90 segundos, se mais de um jogador estiver vivo, spawna bombas aleatórias
        if (gameTime >= 90 * 60) {
            console.log(`Verificando spawn de bomba aleatória: alivePlayers: ${alivePlayers.length}, tempo desde último spawn: ${gameTime - lastBombSpawnTime}`);
            if (alivePlayers.length > 1) {
                if (gameTime - lastBombSpawnTime >= 5 * 60) {
                    const position = findValidSpawnPosition();
                    if (position) {
                        const { x, y } = position;
                        const bomb = {
                            id: bombIdCounter++,
                            x,
                            y,
                            rect: [x, y, TILE_SIZE, TILE_SIZE],
                            timer: 60,
                            exploded: false,
                            explosion_areas: [],
                            blast_range: 3,
                            kicked: false,
                            kick_dx: 0,
                            kick_dy: 0,
                            kick_speed: 4,
                            owner_id: null
                        };
                        bombs.push(bomb);
                        console.log(`Bomba aleatória spawnada em x:${x}, y:${y}, ID:${bomb.id}`);
                        lastBombSpawnTime = gameTime;
                    } else {
                        console.log('Falha ao spawnar bomba: posição inválida');
                    }
                }
            } else {
                console.log('Spawn de bomba cancelado: menos de 2 jogadores vivos');
            }
        }

        // Verifica condição de vitória
        if (alivePlayers.length <= 1) {
            gameOver = true;
            const winner = alivePlayers.length === 1 ? alivePlayers[0].name : null;
            console.log(`Jogo terminado. Vencedor: ${winner || 'Empate'}`);
            broadcast({ type: 'game_over', winner });
        }

        broadcastState();
    }
}, 1000 / 60);

// Envia o estado do jogo para todos os clientes
function broadcastState() {
    const state = {
        type: 'state',
        gameStarted,
        gameOver,
        players,
        walls,
        blocks,
        powerups,
        bombs,
        gameTime, // Envia gameTime para o cliente
        blocksClearedTime // Envia blocksClearedTime para o cliente
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(state));
        }
    });
}

function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Serve arquivos estáticos (HTML, JS, assets)
app.use(express.static(path.join(__dirname, 'public')));

// Inicia o servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});