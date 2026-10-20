const API_BASE = 'https://jiosaavn-api-codyandersan.vercel.app';
        const PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#2a2a2a"/><text x="50%" y="54%" font-size="64" text-anchor="middle" fill="#777">&#9835;</text></svg>'
        );

        let currentSong = null;
        let queue = [];
        let currentIndex = -1;
        let playlists = JSON.parse(localStorage.getItem('playlists')) || [];
        let favorites = JSON.parse(localStorage.getItem('favorites')) || [];
        let recentlyPlayed = JSON.parse(localStorage.getItem('recentlyPlayed')) || [];
        let isPlaying = false;
        let isShuffleOn = false;
        let repeatMode = 'off';
        let playerExpanded = false;
        const audio = document.getElementById('audioPlayer');
        let currentPlaylistForAdd = null;
        let wakeLock = null;

        let currentContext = {
            type: null,
            id: null,
            url: null,
            name: null,
            songs: [],
            currentPage: 0,
            totalSongs: 0,
            hasMore: false,
            isLoading: false
        };

        let settings = JSON.parse(localStorage.getItem('settings')) || {
            audioQuality: 'high',
            playbackSpeed: 1
        };

        // ========== YOUTUBE INTEGRATION ==========
        const YOUTUBE_API_BASE = 'https://hivajoyweb.onrender.com/api/youtube';
        const YOUTUBE_DOWNLOAD_API = 'https://youtube-mp36.p.rapidapi.com/dl';
        const RAPIDAPI_KEY = '43db6998cdmsh2ebabcbb7bfe84ep1865b9jsn0406325a9b5c';

        let youtubeResults = [];
        let currentYouTubePage = 1;
        let hasMoreYouTubeResults = false;
        let isYouTubeView = false;

        // ========== API RESPONSE NORMALIZATION ==========
        // New API format:
        //  image: [{quality, link}]            -> [{quality, url}]
        //  downloadUrl: [{quality, link}]      -> [{quality, url}]
        //  primaryArtists / primaryArtistsId   -> artists.primary [{id, name}]
        //  featuredArtists / featuredArtistsId -> artists.featured [{id, name}]
        //  duration: "209" (string)            -> 209 (number)
        function normalizeMediaList(list) {
            if (!Array.isArray(list)) {
                if (typeof list === 'string' && list) return [{ quality: '500x500', url: list }];
                return [];
            }
            return list
                .map(entry => {
                    if (typeof entry === 'string') return { quality: '', url: entry };
                    return {
                        quality: entry.quality || '',
                        url: entry.link || entry.url || ''
                    };
                })
                .filter(entry => entry.url);
        }

        function splitArtists(names, ids) {
            if (!names) return [];
            if (Array.isArray(names)) {
                return names
                    .map(a => (typeof a === 'string' ? { id: '', name: a } : { id: a.id || '', name: a.name || '' }))
                    .filter(a => a.name);
            }
            const nameList = String(names).split(',').map(n => n.trim()).filter(Boolean);
            const idList = ids ? String(ids).split(',').map(i => i.trim()) : [];
            return nameList.map((name, i) => ({ id: idList[i] || '', name }));
        }

        function normalizeItem(item) {
            if (!item || typeof item !== 'object') return item;

            item.image = normalizeMediaList(item.image);
            item.downloadUrl = normalizeMediaList(item.downloadUrl);

            // Artists: primary and featured stay separate
            const hasNewArtists = item.artists && Array.isArray(item.artists.primary);
            const primary = hasNewArtists
                ? splitArtists(item.artists.primary)
                : splitArtists(item.primaryArtists, item.primaryArtistsId);
            const featured = hasNewArtists
                ? splitArtists(item.artists.featured || [])
                : splitArtists(item.featuredArtists, item.featuredArtistsId);

            item.artists = {
                primary,
                featured,
                all: [...primary, ...featured]
            };

            if (item.album && typeof item.album === 'string') {
                item.album = { id: '', name: item.album, url: '' };
            }

            if (item.duration !== undefined && item.duration !== null) {
                item.duration = parseInt(item.duration) || 0;
            }

            // Songs come with empty type in this API
            if (!item.type && item.downloadUrl.length > 0) {
                item.type = 'song';
            }

            return item;
        }

        function normalizeResponse(data) {
            if (!data || !data.data) return data;
            const d = data.data;

            if (Array.isArray(d)) {
                data.data = d.map(normalizeItem);
            } else if (typeof d === 'object') {
                ['results', 'songs', 'albums', 'playlists', 'artists'].forEach(key => {
                    if (Array.isArray(d[key])) d[key] = d[key].map(normalizeItem);
                });
                if (d.image) d.image = normalizeMediaList(d.image);
            }
            return data;
        }

        // Safely get a list of items from different response shapes
        function extractList(data) {
            const d = data?.data;
            if (!d) return [];
            if (Array.isArray(d)) return d;
            return d.results || d.songs || [];
        }

        // ========== HELPERS ==========
        function getImageUrl(item, preferredIndex = 2) {
            const imgs = item?.image;
            if (!Array.isArray(imgs) || !imgs.length) return PLACEHOLDER_IMG;
            return imgs[preferredIndex]?.url
                || imgs[imgs.length - 1]?.url
                || imgs[0]?.url
                || PLACEHOLDER_IMG;
        }

        function getArtistNames(item, fallback = 'Unknown Artist') {
            const all = item?.artists?.all?.length
                ? item.artists.all
                : (item?.artists?.primary || []);
            const names = all.map(a => a.name).filter(Boolean).join(', ');
            return names || fallback;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text == null ? '' : String(text);
            return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Safe for use inside onclick="fn('...')"
        function attrStr(text) {
            const js = String(text == null ? '' : text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return escapeHtml(js);
        }

        // ✅ BACKGROUND PLAYBACK - Wake Lock
        async function requestWakeLock() {
            if ('wakeLock' in navigator) {
                try {
                    wakeLock = await navigator.wakeLock.request('screen');
                    wakeLock.addEventListener('release', () => {
                        console.log('Wake Lock released');
                    });
                } catch (err) {
                    console.log('Wake Lock not supported:', err);
                }
            }
        }

        function releaseWakeLock() {
            if (wakeLock !== null) {
                wakeLock.release().then(() => {
                    wakeLock = null;
                });
            }
        }

        document.addEventListener('visibilitychange', async () => {
            if (wakeLock !== null && document.visibilityState === 'visible') {
                await requestWakeLock();
            }
        });

        // ✅ MEDIA SESSION
        function setupMediaSession(song) {
            if ('mediaSession' in navigator) {
                const imageUrl = getImageUrl(song, 2);
                const artistName = getArtistNames(song);

                navigator.mediaSession.metadata = new MediaMetadata({
                    title: song.name || 'Unknown Song',
                    artist: artistName,
                    album: song.album?.name || 'MusicBox',
                    artwork: [
                        { src: imageUrl, sizes: '96x96', type: 'image/jpeg' },
                        { src: imageUrl, sizes: '128x128', type: 'image/jpeg' },
                        { src: imageUrl, sizes: '192x192', type: 'image/jpeg' },
                        { src: imageUrl, sizes: '256x256', type: 'image/jpeg' },
                        { src: imageUrl, sizes: '384x384', type: 'image/jpeg' },
                        { src: imageUrl, sizes: '512x512', type: 'image/jpeg' }
                    ]
                });

                navigator.mediaSession.setActionHandler('play', () => {
                    audio.play()
                        .then(() => {
                            isPlaying = true;
                            updatePlayPauseButtons();
                            requestWakeLock();
                        })
                        .catch(err => console.error('Media session play error:', err));
                });

                navigator.mediaSession.setActionHandler('pause', () => {
                    audio.pause();
                    isPlaying = false;
                    updatePlayPauseButtons();
                    releaseWakeLock();
                });

                navigator.mediaSession.setActionHandler('previoustrack', () => previousSong());
                navigator.mediaSession.setActionHandler('nexttrack', () => nextSong());

                navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                    audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 10), 0);
                });

                navigator.mediaSession.setActionHandler('seekforward', (details) => {
                    audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 10), audio.duration);
                });

                navigator.mediaSession.setActionHandler('seekto', (details) => {
                    if (details.fastSeek && 'fastSeek' in audio) {
                        audio.fastSeek(details.seekTime);
                    } else {
                        audio.currentTime = details.seekTime;
                    }
                });

                updatePositionState();
            }
        }

        function updatePositionState() {
            if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
                if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
                    navigator.mediaSession.setPositionState({
                        duration: audio.duration,
                        playbackRate: audio.playbackRate,
                        position: Math.min(audio.currentTime, audio.duration)
                    });
                }
            }
        }

        // ✅ INIT
        (function() {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initApp);
            } else {
                initApp();
            }
        })();

        function initApp() {
            const themeIcon = document.getElementById('themeIcon');
            if (themeIcon) {
                const savedTheme = localStorage.getItem('theme') || 'dark';
                themeIcon.className = savedTheme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
            }

            loadHome();
            setupAudioListeners();
            setupSearchListener();
            setupMobileSearchListener();
            updateMyPlaylistsDisplay();
            updateStats();
            updateBadges();
            loadSettings();
        }

        // ✅ AUDIO LISTENERS
        function setupAudioListeners() {
            audio.addEventListener('timeupdate', () => {
                updateProgress();
                updatePositionState();
            });

            audio.addEventListener('ended', handleSongEnd);

            audio.addEventListener('loadedmetadata', function() {
                const duration = document.getElementById('duration');
                const fullscreenDuration = document.getElementById('fullscreenDuration');

                if (duration) duration.textContent = formatTime(audio.duration);
                if (fullscreenDuration) fullscreenDuration.textContent = formatTime(audio.duration);

                updatePositionState();
            });

            audio.addEventListener('play', () => {
                isPlaying = true;
                updatePlayPauseButtons();
            });

            audio.addEventListener('pause', () => {
                if (!audio.ended) {
                    isPlaying = false;
                    updatePlayPauseButtons();
                }
            });

            audio.addEventListener('error', (e) => {
                console.error('Audio error:', e);
                isPlaying = false;
                updatePlayPauseButtons();
                showToast('Playback error', 'error');
            });

            audio.addEventListener('waiting', () => console.log('Buffering...'));
            audio.addEventListener('canplay', () => console.log('Can play'));
        }

        function handleSongEnd() {
            if (repeatMode === 'one') {
                audio.currentTime = 0;
                audio.play();
            } else {
                nextSong();
            }
        }

        function setupSearchListener() {
            const searchInput = document.getElementById('searchInput');
            if (!searchInput) return;

            searchInput.addEventListener('input', function(e) {
                const clearBtn = document.getElementById('searchClear');
                if (e.target.value.length > 0) clearBtn.classList.add('active');
                else clearBtn.classList.remove('active');
            });

            searchInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    search();
                }
            });
        }

        function setupMobileSearchListener() {
            const searchInputMobile = document.getElementById('searchInputMobile');
            if (!searchInputMobile) return;

            searchInputMobile.addEventListener('input', function(e) {
                const clearBtn = document.getElementById('searchClearMobile');
                if (e.target.value.length > 0) clearBtn.classList.add('active');
                else clearBtn.classList.remove('active');
            });

            searchInputMobile.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchMobile();
                }
            });
        }

        function clearSearch() {
            const searchInput = document.getElementById('searchInput');
            const clearBtn = document.getElementById('searchClear');
            if (searchInput) searchInput.value = '';
            if (clearBtn) clearBtn.classList.remove('active');
        }

        function clearMobileSearch() {
            const searchInput = document.getElementById('searchInputMobile');
            const clearBtn = document.getElementById('searchClearMobile');
            if (searchInput) searchInput.value = '';
            if (clearBtn) clearBtn.classList.remove('active');
        }

        function search() {
            const query = document.getElementById('searchInput').value.trim();
            const type = document.getElementById('searchType').value;

            if (!query) {
                showToast('Please enter a search term', 'warning');
                return;
            }

            performSearch(query, type);
        }

        function searchMobile() {
            const query = document.getElementById('searchInputMobile').value.trim();
            const type = document.getElementById('searchTypeMobile').value;

            if (!query) {
                showToast('Please enter a search term', 'warning');
                return;
            }

            closeMobileSearch();

            setTimeout(() => {
                scrollToTop(false);
                performSearch(query, type);
            }, 100);
        }

        function buildSearchEndpoint(type, query, page) {
            const q = encodeURIComponent(query);
            switch (type) {
                case 'songs': return `/search/songs?query=${q}&page=${page}&limit=20`;
                case 'albums': return `/search/albums?query=${q}&page=${page}&limit=20`;
                case 'artists': return `/search/artists?query=${q}&page=${page}&limit=20`;
                case 'playlists': return `/search/playlists?query=${q}&page=${page}&limit=20`;
                default: return `/search?query=${q}&page=${page}&limit=20`;
            }
        }

        // ✅ SEARCH
        async function performSearch(query, type) {
            scrollToTop(false);

            currentContext = {
                type: 'search',
                id: null,
                url: null,
                name: query,
                songs: [],
                albums: [],
                playlists: [],
                artists: [],
                currentPage: 1,
                totalSongs: 0,
                hasMore: false,
                isLoading: false,
                searchType: type,
                query: query,
                loadedIds: new Set()
            };

            switchTab('search-results');
            showLoading('searchResultsGrid');
            document.getElementById('loadMoreContainer').classList.remove('active');

            hideYouTubeSection();

            const promises = [fetchAPI(buildSearchEndpoint(type, query, 1))];

            if (type === 'songs') {
                showLoading('youtubeResultsGrid');
                promises.push(searchYouTube(query, 1));
            }

            const [saavnData, youtubeData] = await Promise.all(promises);
            const saavnResults = extractList(saavnData);

            // ========== SAAVN RESULTS ==========
            if (saavnResults.length > 0) {
                document.getElementById('searchResultsTitle').innerHTML = `<i class="fas fa-search"></i> "${escapeHtml(query)}"`;

                currentContext.totalSongs = saavnData.data.total || saavnResults.length;
                currentContext.hasMore = type !== 'all' && type !== undefined && saavnResults.length >= 20;

                if (type === 'albums') {
                    currentContext.albums = saavnResults;
                    saavnResults.forEach(a => currentContext.loadedIds.add(a.id));
                    displayAlbums(saavnResults, 'searchResultsGrid');
                } else if (type === 'playlists') {
                    currentContext.playlists = saavnResults;
                    saavnResults.forEach(p => currentContext.loadedIds.add(p.id));
                    displayPlaylists(saavnResults, 'searchResultsGrid');
                } else if (type === 'artists') {
                    currentContext.artists = saavnResults;
                    saavnResults.forEach(a => currentContext.loadedIds.add(a.id));
                    displayArtists(saavnResults, 'searchResultsGrid');
                } else if (type === 'songs') {
                    currentContext.songs = saavnResults;
                    saavnResults.forEach(s => currentContext.loadedIds.add(s.id));
                    displaySongs(saavnResults, 'searchResultsGrid');
                } else {
                    displayMixedResults(saavnResults, 'searchResultsGrid');
                }

                document.getElementById('saavnResultsCount').textContent = saavnResults.length;

                if (currentContext.hasMore) {
                    document.getElementById('loadMoreContainer').classList.add('active');
                }
            } else {
                document.getElementById('searchResultsGrid').innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><p>No Saavn results found</p></div>';
                document.getElementById('saavnResultsCount').textContent = '0';
            }

            // ========== YOUTUBE RESULTS (songs only) ==========
            if (type === 'songs') {
                if (youtubeData?.results && youtubeData.results.length > 0) {
                    youtubeResults = youtubeData.results;
                    currentYouTubePage = 1;
                    hasMoreYouTubeResults = youtubeData.hasMore;

                    displayYouTubeResults(youtubeData.results, 'youtubeResultsGrid');
                    document.getElementById('youtubeResultsCount').textContent = youtubeData.results.length;

                    showYouTubeSection();

                    document.getElementById('searchResultsInfo').innerHTML = `
                        <span><i class="fas fa-music"></i> ${saavnResults.length} Saavn songs</span>
                        <span style="margin-left: 1rem;"><i class="fab fa-youtube"></i> ${youtubeData.results.length} YouTube videos</span>
                    `;
                } else {
                    document.getElementById('youtubeResultsGrid').innerHTML = '<div class="empty-state"><i class="fab fa-youtube"></i><p>No YouTube results found</p></div>';
                    document.getElementById('youtubeResultsCount').textContent = '0';

                    showYouTubeSection();

                    document.getElementById('searchResultsInfo').innerHTML = `
                        <span><i class="fas fa-check-circle"></i> ${saavnResults.length} Saavn results</span>
                        <span style="margin-left: 1rem; color: var(--text-muted);"><i class="fab fa-youtube"></i> 0 YouTube results</span>
                    `;
                }
            } else {
                document.getElementById('searchResultsInfo').innerHTML = `
                    <span><i class="fas fa-check-circle"></i> Showing ${saavnResults.length} results</span>
                `;
            }
        }

        function showYouTubeSection() {
            const youtubeSection = document.getElementById('youtubeResultsSection');
            const toggleBtn = document.getElementById('youtubeToggleBtn');
            const searchContainer = document.querySelector('.search-results-container');
            const saavnSection = document.getElementById('saavnResultsSection');

            if (!youtubeSection || !toggleBtn || !searchContainer || !saavnSection) return;

            youtubeSection.classList.add('show-youtube');
            toggleBtn.classList.add('show-toggle');
            searchContainer.classList.add('has-youtube');

            if (window.innerWidth < 1024) {
                youtubeSection.classList.add('mobile-hidden');
                saavnSection.classList.remove('mobile-hidden');

                isYouTubeView = false;
                toggleBtn.classList.remove('active');

                const toggleText = document.getElementById('youtubeToggleText');
                if (toggleText) toggleText.textContent = 'YouTube Results';
            } else {
                youtubeSection.classList.remove('mobile-hidden');
                saavnSection.classList.remove('mobile-hidden');
            }
        }

        function hideYouTubeSection() {
            const youtubeSection = document.getElementById('youtubeResultsSection');
            const toggleBtn = document.getElementById('youtubeToggleBtn');
            const searchContainer = document.querySelector('.search-results-container');
            const saavnSection = document.getElementById('saavnResultsSection');

            if (!youtubeSection || !toggleBtn || !searchContainer || !saavnSection) return;

            youtubeSection.classList.remove('show-youtube');
            youtubeSection.classList.remove('mobile-hidden');
            toggleBtn.classList.remove('show-toggle');
            toggleBtn.classList.remove('active');
            searchContainer.classList.remove('has-youtube');

            saavnSection.classList.remove('mobile-hidden');

            isYouTubeView = false;

            const youtubeGrid = document.getElementById('youtubeResultsGrid');
            const youtubeCount = document.getElementById('youtubeResultsCount');
            if (youtubeGrid) youtubeGrid.innerHTML = '';
            if (youtubeCount) youtubeCount.textContent = '0';
        }

        function toggleYouTubeResults() {
            isYouTubeView = !isYouTubeView;

            const saavnSection = document.getElementById('saavnResultsSection');
            const youtubeSection = document.getElementById('youtubeResultsSection');
            const toggleBtn = document.getElementById('youtubeToggleBtn');
            const toggleText = document.getElementById('youtubeToggleText');

            if (!saavnSection || !youtubeSection || !toggleBtn || !toggleText) return;

            if (isYouTubeView) {
                saavnSection.classList.add('mobile-hidden');
                youtubeSection.classList.remove('mobile-hidden');
                toggleBtn.classList.add('active');
                toggleText.textContent = 'Saavn Results';
            } else {
                saavnSection.classList.remove('mobile-hidden');
                youtubeSection.classList.add('mobile-hidden');
                toggleBtn.classList.remove('active');
                toggleText.textContent = 'YouTube Results';
            }
        }

        // ✅ YOUTUBE FUNCTIONS
        async function searchYouTube(query, page = 1) {
            try {
                const response = await fetch(`${YOUTUBE_API_BASE}/search?q=${encodeURIComponent(query)}&page=${page}&limit=25`);
                return await response.json();
            } catch (error) {
                console.error('YouTube search error:', error);
                return null;
            }
        }

        async function getYouTubeAudioLink(videoId) {
            try {
                const response = await fetch(`${YOUTUBE_DOWNLOAD_API}?id=${videoId}`, {
                    headers: {
                        'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
                        'x-rapidapi-key': RAPIDAPI_KEY
                    }
                });
                return await response.json();
            } catch (error) {
                console.error('YouTube download error:', error);
                return null;
            }
        }

        function displayYouTubeResults(results, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (!results?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fab fa-youtube"></i><p>No YouTube results found</p></div>';
                return;
            }

            const resultsHTML = results.map((video, index) => {
                const videoIndex = append ? (youtubeResults.length - results.length + index) : index;

                return `
                    <div class="card youtube-card" onclick="playYouTubeVideo(${videoIndex})">
                        <div class="card-img-container">
                            <img src="${video.thumbnailHigh || video.thumbnailSmall}" class="card-img" loading="lazy" alt="${escapeHtml(video.title)}">
                            <div class="card-badge">
                                <i class="fab fa-youtube"></i> ${video.duration}
                            </div>
                            <div class="play-overlay">
                                <i class="fas fa-play"></i>
                            </div>
                        </div>
                        <div class="card-title">${video.title}</div>
                        <div class="card-subtitle">
                            <div style="display: flex; align-items: center; gap: 0.25rem; margin-bottom: 0.25rem;">
                                <i class="fas fa-user" style="font-size: 0.7rem;"></i>
                                <span>${video.channelName}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem;">
                                <span><i class="fas fa-eye"></i> ${video.views}</span>
                                <span><i class="fas fa-clock"></i> ${video.publishedTime}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + resultsHTML : resultsHTML;
        }

        // ========== PLAYER LOADING STATE ==========
        function showPlayerLoadingState(isLoading) {
            ['playPauseBtnMini', 'playPauseBtn', 'fullscreenPlayPauseBtn'].forEach(id => {
                const btn = document.getElementById(id);
                if (!btn) return;
                if (isLoading) {
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                    btn.disabled = true;
                } else {
                    btn.innerHTML = `<i class="fas fa-${isPlaying ? 'pause' : 'play'}"></i>`;
                    btn.disabled = false;
                }
            });

            const playerImg = document.getElementById('playerImgMini');
            if (playerImg) {
                if (isLoading) playerImg.classList.add('loading');
                else playerImg.classList.remove('loading');
            }
        }

        async function playYouTubeVideo(index) {
            const video = youtubeResults[index];
            if (!video) return;

            const youtubeSong = {
                id: `yt_${video.videoId}`,
                name: video.title,
                type: 'youtube',
                duration: parseDuration(video.duration),
                image: [
                    { quality: '50x50', url: video.thumbnailSmall },
                    { quality: '150x150', url: video.thumbnailSmall },
                    { quality: '500x500', url: video.thumbnailHigh }
                ],
                downloadUrl: [],
                artists: {
                    primary: [{ id: '', name: video.channelName }],
                    featured: [],
                    all: [{ id: '', name: video.channelName }]
                },
                album: { name: 'YouTube' },
                url: `https://youtube.com/watch?v=${video.videoId}`
            };

            currentSong = youtubeSong;
            updatePlayerUI(false);
            updateFullscreenPlayerUI(false);

            showPlayerLoadingState(true);
            showToast('⏳ Loading from YouTube...', 'info');

            try {
                const audioData = await getYouTubeAudioLink(video.videoId);

                if (audioData && audioData.status === 'ok' && audioData.link) {
                    youtubeSong.downloadUrl = [
                        { quality: '128kbps', url: audioData.link },
                        { quality: '160kbps', url: audioData.link },
                        { quality: '320kbps', url: audioData.link }
                    ];

                    audio.src = audioData.link;
                    audio.playbackRate = settings.playbackSpeed;
                    audio.preload = 'auto';

                    audio.play()
                        .then(() => {
                            showPlayerLoadingState(false);
                            isPlaying = true;
                            updatePlayPauseButtons();
                            requestWakeLock();
                            showToast('▶️ Playing from YouTube', 'success');
                        })
                        .catch(err => {
                            console.error('Play error:', err);
                            showPlayerLoadingState(false);
                            isPlaying = false;
                            updatePlayPauseButtons();
                            showToast('Playback failed', 'error');
                        });

                    addToRecentlyPlayed(youtubeSong);
                    setupMediaSession(youtubeSong);

                    if (!queue.find(s => s.id === youtubeSong.id)) {
                        queue.push(youtubeSong);
                    }
                    currentIndex = queue.findIndex(s => s.id === youtubeSong.id);

                    updateQueueDisplay();
                    updateBadges();
                    updateStats();
                } else {
                    showPlayerLoadingState(false);
                    showToast('Failed to load YouTube audio', 'error');
                }
            } catch (error) {
                console.error('YouTube play error:', error);
                showPlayerLoadingState(false);
                showToast('Failed to play YouTube video', 'error');
            }
        }

        function parseDuration(duration) {
            if (!duration) return 0;
            const parts = duration.split(':').map(Number);
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            return 0;
        }

        // ========== SIDEBAR ==========
        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');

            sidebar.classList.toggle('active');
            overlay.classList.toggle('active');

            if (sidebar.classList.contains('active')) {
                if (window.innerWidth < 1024) document.body.style.overflow = 'hidden';
            } else {
                document.body.style.overflow = '';
            }
        }

        function closeSidebar() {
            document.getElementById('sidebar').classList.remove('active');
            document.getElementById('sidebarOverlay').classList.remove('active');
            document.body.style.overflow = '';
        }

        // ========== API ==========
        async function fetchAPI(endpoint) {
            try {
                const response = await fetch(`${API_BASE}${endpoint}`);
                const data = await response.json();
                return normalizeResponse(data);
            } catch (error) {
                console.error('API Error:', error);
                showToast('Network error', 'error');
                return null;
            }
        }

        // ========== HOME ==========
        async function loadHome() {
            showSkeletonLoader('trendingNow', 6);
            showSkeletonLoader('popularAlbums', 6);
            showSkeletonLoader('editorialPicks', 6);
            showSkeletonLoader('topCharts', 6);
            showSkeletonLoader('madeForYou', 6);

            await Promise.allSettled([
                loadTrendingNow(),
                loadPopularAlbums(),
                loadEditorialPicks(),
                loadTopCharts(),
                loadMadeForYou()
            ]);
            updateStats();
        }

        function showSectionError(gridId) {
            const grid = document.getElementById(gridId);
            if (!grid) return;
            grid.className = 'grid';
            grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
        }

        async function loadTrendingNow() {
            try {
                const data = await fetchAPI('/search/playlists?query=trending viral&page=1&limit=6');
                const list = extractList(data);
                if (!list.length) throw new Error('No results');
                document.getElementById('trendingNow').className = 'grid';
                displayPlaylists(list, 'trendingNow');
            } catch (error) {
                showSectionError('trendingNow');
            }
        }

        async function loadPopularAlbums() {
            try {
                const data = await fetchAPI('/search/albums?query=latest bollywood 2024&page=1&limit=6');
                const list = extractList(data);
                if (!list.length) throw new Error('No results');
                document.getElementById('popularAlbums').className = 'grid';
                displayAlbums(list, 'popularAlbums');
            } catch (error) {
                showSectionError('popularAlbums');
            }
        }

        async function loadEditorialPicks() {
            try {
                const data = await fetchAPI('/search/albums?query=fresh music 2024&page=1&limit=6');
                const list = extractList(data);
                if (!list.length) throw new Error('No results');
                document.getElementById('editorialPicks').className = 'grid';
                displayAlbums(list, 'editorialPicks');
            } catch (error) {
                showSectionError('editorialPicks');
            }
        }

        async function loadTopCharts() {
            try {
                const responses = await Promise.all([
                    fetchAPI('/search/playlists?query=Most Streamed Love Songs Hindi&page=1&limit=2'),
                    fetchAPI('/search/playlists?query=Most Streamed Love Songs English&page=1&limit=2'),
                    fetchAPI('/search/playlists?query=Trending Today&page=1&limit=2'),
                    fetchAPI('/search/playlists?query=Most Searched Songs Hindi&page=1&limit=2')
                ]);

                const lists = responses.map(extractList);

                let combinedResults = [];
                lists.forEach(l => { if (l.length) combinedResults.push(l[0]); });

                const allResults = lists.flatMap(l => l.slice(1));
                const addedIds = new Set(combinedResults.map(r => r.id));
                const uniqueResults = allResults.filter(r => !addedIds.has(r.id));
                combinedResults = [...combinedResults, ...uniqueResults].slice(0, 6);

                if (!combinedResults.length) throw new Error('No results');

                document.getElementById('topCharts').className = 'grid';
                displayPlaylists(combinedResults, 'topCharts');
            } catch (error) {
                showSectionError('topCharts');
            }
        }

        async function loadMadeForYou() {
            try {
                const data = await fetchAPI('/search/playlists?query=romantic love hindi&page=1&limit=6');
                const list = extractList(data);
                if (!list.length) throw new Error('No results');
                document.getElementById('madeForYou').className = 'grid';
                displayPlaylists(list, 'madeForYou');
            } catch (error) {
                showSectionError('madeForYou');
            }
        }

        function loadTrendingPlaylistsTab() {
            scrollToTop(false);
            switchTab('trending-playlists');
            if (!document.getElementById('trendingPlaylistsGrid').innerHTML) {
                loadTrendingPlaylists();
            }
        }

        function loadTrendingAlbumsTab() {
            scrollToTop(false);
            switchTab('trending-albums');
            if (!document.getElementById('trendingAlbumsGrid').innerHTML) {
                loadTrendingAlbums();
            }
        }

        async function loadTrendingPlaylists() {
            showLoading('trendingPlaylistsGrid');
            const data = await fetchAPI('/search/playlists?query=trending&page=1&limit=20');
            const list = extractList(data);
            if (list.length) displayPlaylists(list, 'trendingPlaylistsGrid');
        }

        async function loadTrendingAlbums() {
            showLoading('trendingAlbumsGrid');
            const data = await fetchAPI('/search/albums?query=2024&page=1&limit=20');
            const list = extractList(data);
            if (list.length) displayAlbums(list, 'trendingAlbumsGrid');
        }

        async function filterPlaylists(category) {
            scrollToTop(true);

            document.querySelectorAll('#trending-playlists .chip').forEach(c => c.classList.remove('active'));
            if (typeof event !== 'undefined' && event?.target) event.target.classList.add('active');
            showLoading('trendingPlaylistsGrid');
            const query = category === 'all' ? 'trending' : category;
            const data = await fetchAPI(`/search/playlists?query=${encodeURIComponent(query)}&page=1&limit=20`);
            const list = extractList(data);
            if (list.length) displayPlaylists(list, 'trendingPlaylistsGrid');
        }

        async function filterAlbums(category) {
            scrollToTop(true);

            document.querySelectorAll('#trending-albums .chip').forEach(c => c.classList.remove('active'));
            if (typeof event !== 'undefined' && event?.target) event.target.classList.add('active');
            showLoading('trendingAlbumsGrid');
            const query = category === 'all' ? '2024' : category;
            const data = await fetchAPI(`/search/albums?query=${encodeURIComponent(query)}&page=1&limit=20`);
            const list = extractList(data);
            if (list.length) displayAlbums(list, 'trendingAlbumsGrid');
        }

        // ========== LOAD MORE ==========
        // Supports: search (page starts at 1) and artist songs (page starts at 1).
        // Albums and playlists have no pagination in this API.
        async function loadMore() {
            if (currentContext.isLoading || !currentContext.hasMore) return;

            const btn = document.getElementById('loadMoreBtn');
            const btnText = document.getElementById('loadMoreText');

            currentContext.isLoading = true;
            btn.disabled = true;
            btnText.textContent = 'Loading...';
            currentContext.currentPage++;

            let list = [];

            if (currentContext.type === 'search') {
                const { query, searchType, currentPage } = currentContext;
                const data = await fetchAPI(buildSearchEndpoint(searchType, query, currentPage));
                list = extractList(data);
            } else if (currentContext.type === 'artist') {
                const data = await fetchAPI(`/artists/${currentContext.id}/songs?page=${currentContext.currentPage}`);
                list = extractList(data);
            }

            // Only keep items we haven't loaded yet
            const newItems = [];
            list.forEach(item => {
                if (!currentContext.loadedIds.has(item.id)) {
                    newItems.push(item);
                    currentContext.loadedIds.add(item.id);
                }
            });

            if (newItems.length === 0) {
                currentContext.hasMore = false;
            } else {
                if (currentContext.type === 'artist' || currentContext.searchType === 'songs') {
                    currentContext.songs = [...currentContext.songs, ...newItems];
                    displaySongs(newItems, 'searchResultsGrid', true);
                } else if (currentContext.searchType === 'albums') {
                    currentContext.albums = [...currentContext.albums, ...newItems];
                    displayAlbums(newItems, 'searchResultsGrid', true);
                } else if (currentContext.searchType === 'playlists') {
                    currentContext.playlists = [...currentContext.playlists, ...newItems];
                    displayPlaylists(newItems, 'searchResultsGrid', true);
                } else if (currentContext.searchType === 'artists') {
                    currentContext.artists = [...currentContext.artists, ...newItems];
                    displayArtists(newItems, 'searchResultsGrid', true);
                }

                const currentCount = document.querySelectorAll('#searchResultsGrid .card').length;
                document.getElementById('searchResultsInfo').innerHTML = `
                    <span><i class="fas fa-check-circle"></i> Showing ${currentCount} results</span>
                `;

                currentContext.hasMore = list.length >= (currentContext.type === 'artist' ? 10 : 20);
                showToast(`+${newItems.length} loaded`, 'success');
            }

            if (!currentContext.hasMore) {
                document.getElementById('loadMoreContainer').classList.remove('active');
                const totalLoaded = document.querySelectorAll('#searchResultsGrid .card').length;
                showToast(`All loaded! Total: ${totalLoaded}`, 'success');
            }

            btn.disabled = false;
            btnText.textContent = 'Load More';
            currentContext.isLoading = false;
        }

        // ========== DISPLAY FUNCTIONS ==========
        function displaySongs(songs, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (!songs?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fas fa-music"></i><p>No songs found</p></div>';
                return;
            }

            const songsHTML = songs.map((song, index) => {
                const imageUrl = getImageUrl(song, 2);
                const artistName = getArtistNames(song);
                const isFav = favorites.find(f => f.id === song.id);
                const songIndex = append ? (currentContext.songs.length - songs.length + index) : index;

                return `
                    <div class="card">
                        <div class="card-img-container">
                            <img src="${imageUrl}" class="card-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                            ${song.duration ? `<div class="card-badge"><i class="fas fa-clock"></i> ${formatTime(song.duration)}</div>` : ''}
                            <div class="play-overlay" onclick="event.stopPropagation(); playSongByIndex(${songIndex})">
                                <i class="fas fa-play"></i>
                            </div>
                        </div>
                        <div class="card-title">${song.name || 'Unknown Song'}</div>
                        <div class="card-subtitle">${artistName}</div>
                        <div class="card-actions">
                            <button class="icon-btn" onclick="event.stopPropagation(); addSongToQueue(${songIndex})" title="Add to queue">
                                <i class="fas fa-plus"></i>
                            </button>
                            <button class="icon-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavoriteSongByIndex(${songIndex})" title="Favorite">
                                <i class="fas fa-heart"></i>
                            </button>
                            <button class="icon-btn" onclick="event.stopPropagation(); downloadSongByIndex(${songIndex})" title="Download">
                                <i class="fas fa-download"></i>
                            </button>
                            <button class="icon-btn" onclick="event.stopPropagation(); addSongToPlaylistByIndex(${songIndex})" title="Add to playlist">
                                <i class="fas fa-list"></i>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + songsHTML : songsHTML;
        }

        function displayPlaylists(playlists, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (grid.classList.contains('skeleton-grid')) grid.className = 'grid';

            if (!playlists?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fas fa-list-music"></i><p>No playlists found</p></div>';
                return;
            }

            const playlistsHTML = playlists.map(playlist => {
                const imageUrl = getImageUrl(playlist, 2);

                return `
                    <div class="card" onclick="loadOnlinePlaylist('${attrStr(playlist.id)}', '${encodeURIComponent(playlist.url || '')}', '${attrStr(playlist.name)}')">
                        <div class="card-img-container">
                            <img src="${imageUrl}" class="card-img" loading="lazy" alt="${escapeHtml(playlist.name || 'Playlist cover')}" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                            ${playlist.songCount ? `<div class="card-badge"><i class="fas fa-music"></i> ${playlist.songCount}</div>` : ''}
                            <div class="play-overlay">
                                <i class="fas fa-play"></i>
                            </div>
                        </div>
                        <div class="card-title">${playlist.name}</div>
                        <div class="card-subtitle">${playlist.songCount || 0} songs</div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + playlistsHTML : playlistsHTML;
        }

        function displayAlbums(albums, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (grid.classList.contains('skeleton-grid')) grid.className = 'grid';

            if (!albums?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fas fa-compact-disc"></i><p>No albums found</p></div>';
                return;
            }

            const albumsHTML = albums.map(album => {
                const imageUrl = getImageUrl(album, 2);
                const artistName = getArtistNames(album, 'Various Artists');

                return `
                    <div class="card" onclick="loadAlbum('${attrStr(album.id)}', '${attrStr(album.name)}')">
                        <div class="card-img-container">
                            <img src="${imageUrl}" class="card-img" loading="lazy" alt="${escapeHtml(album.name || 'Album cover')}" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                            ${album.songCount ? `<div class="card-badge"><i class="fas fa-music"></i> ${album.songCount}</div>` : ''}
                            <div class="play-overlay">
                                <i class="fas fa-play"></i>
                            </div>
                        </div>
                        <div class="card-title">${album.name}</div>
                        <div class="card-subtitle">${artistName}</div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + albumsHTML : albumsHTML;
        }

        function displayArtists(artists, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (!artists?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fas fa-user"></i><p>No artists found</p></div>';
                return;
            }

            const artistsHTML = artists.map(artist => {
                const imageUrl = getImageUrl(artist, 2);

                return `
                    <div class="card artist-card" onclick="loadArtistSongs('${attrStr(artist.id)}', '${attrStr(artist.name)}')">
                        <div class="card-img-container">
                            <img src="${imageUrl}" class="card-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                            <div class="play-overlay">
                                <i class="fas fa-play"></i>
                            </div>
                        </div>
                        <div class="card-title">${artist.name}</div>
                        <div class="card-subtitle">Artist</div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + artistsHTML : artistsHTML;
        }

        function displayMixedResults(results, gridId, append = false) {
            const grid = document.getElementById(gridId);
            if (!grid) return;

            if (!results?.length) {
                if (!append) grid.innerHTML = '<div class="empty-state"><i class="fas fa-search"></i><p>No results found</p></div>';
                return;
            }

            const resultsHTML = results.map(item => {
                const imageUrl = getImageUrl(item, 2);
                const imgTag = `<img src="${imageUrl}" class="card-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">`;

                if (item.type === 'song') {
                    const songIndex = currentContext.songs.length;
                    currentContext.songs.push(item);

                    return `
                        <div class="card">
                            <div class="card-img-container">
                                ${imgTag}
                                <div class="play-overlay" onclick="event.stopPropagation(); playSongByIndex(${songIndex})">
                                    <i class="fas fa-play"></i>
                                </div>
                            </div>
                            <div class="card-title">${item.name}</div>
                            <div class="card-subtitle">${getArtistNames(item, 'Unknown')}</div>
                        </div>
                    `;
                } else if (item.type === 'album') {
                    return `
                        <div class="card" onclick="loadAlbum('${attrStr(item.id)}', '${attrStr(item.name)}')">
                            <div class="card-img-container">
                                ${imgTag}
                                <div class="play-overlay"><i class="fas fa-play"></i></div>
                            </div>
                            <div class="card-title">${item.name}</div>
                            <div class="card-subtitle">Album</div>
                        </div>
                    `;
                } else if (item.type === 'playlist') {
                    return `
                        <div class="card" onclick="loadOnlinePlaylist('${attrStr(item.id)}', '${encodeURIComponent(item.url || '')}', '${attrStr(item.name)}')">
                            <div class="card-img-container">
                                ${imgTag}
                                <div class="play-overlay"><i class="fas fa-play"></i></div>
                            </div>
                            <div class="card-title">${item.name}</div>
                            <div class="card-subtitle">Playlist</div>
                        </div>
                    `;
                } else if (item.type === 'artist') {
                    return `
                        <div class="card artist-card" onclick="loadArtistSongs('${attrStr(item.id)}', '${attrStr(item.name)}')">
                            <div class="card-img-container">
                                ${imgTag}
                                <div class="play-overlay"><i class="fas fa-play"></i></div>
                            </div>
                            <div class="card-title">${item.name}</div>
                            <div class="card-subtitle">Artist</div>
                        </div>
                    `;
                }
                return '';
            }).join('');

            grid.innerHTML = append ? grid.innerHTML + resultsHTML : resultsHTML;
        }

        function playSongByIndex(index) {
            if (currentContext.songs[index]) playSongFromData(currentContext.songs[index], index);
        }

        function addSongToQueue(index) {
            if (currentContext.songs[index]) addToQueue(currentContext.songs[index]);
        }

        function toggleFavoriteSongByIndex(index) {
            if (currentContext.songs[index]) toggleFavoriteSong(currentContext.songs[index]);
        }

        function downloadSongByIndex(index) {
            if (currentContext.songs[index]) downloadSong(currentContext.songs[index]);
        }

        function addSongToPlaylistByIndex(index) {
            if (currentContext.songs[index]) {
                currentPlaylistForAdd = currentContext.songs[index];
                currentSong = currentContext.songs[index];
                openAddToPlaylist();
            }
        }

        // ========== ALBUM / PLAYLIST / ARTIST ==========
        async function loadAlbum(albumId, albumName) {
            scrollToTop(false);

            showLoading('searchResultsGrid');
            switchTab('search-results');
            document.getElementById('searchResultsTitle').innerHTML = `<i class="fas fa-compact-disc"></i> ${escapeHtml(albumName)}`;
            document.getElementById('loadMoreContainer').classList.remove('active');

            hideYouTubeSection();

            currentContext = {
                type: 'album',
                id: albumId,
                name: albumName,
                songs: [],
                currentPage: 0,
                totalSongs: 0,
                hasMore: false,
                isLoading: false,
                loadedIds: new Set()
            };

            const data = await fetchAPI(`/albums?id=${albumId}`);
            if (data?.data?.songs?.length) {
                currentContext.songs = data.data.songs;
                currentContext.totalSongs = data.data.songs.length;
                displaySongs(data.data.songs, 'searchResultsGrid');
                document.getElementById('searchResultsInfo').innerHTML = `<span><i class="fas fa-music"></i> ${data.data.songs.length} songs</span>`;
            } else {
                document.getElementById('searchResultsGrid').innerHTML = '<div class="empty-state"><i class="fas fa-music"></i><p>No songs found in this album</p></div>';
                document.getElementById('searchResultsInfo').innerHTML = '';
            }
        }

        // Playlist: only id is needed (no page / limit)
        async function loadOnlinePlaylist(playlistId, playlistUrl, playlistName) {
            scrollToTop(false);

            showLoading('searchResultsGrid');
            switchTab('search-results');
            document.getElementById('searchResultsTitle').innerHTML = `<i class="fas fa-list-music"></i> ${escapeHtml(playlistName)}`;
            document.getElementById('loadMoreContainer').classList.remove('active');

            hideYouTubeSection();

            currentContext = {
                type: 'playlist',
                id: playlistId,
                url: decodeURIComponent(playlistUrl),
                name: playlistName,
                songs: [],
                currentPage: 0,
                totalSongs: 0,
                hasMore: false,
                isLoading: false,
                loadedIds: new Set()
            };

            const data = await fetchAPI(`/playlists?id=${playlistId}`);

            if (data?.data?.songs?.length) {
                currentContext.songs = data.data.songs;
                data.data.songs.forEach(s => currentContext.loadedIds.add(s.id));
                currentContext.totalSongs = data.data.songs.length;

                displaySongs(data.data.songs, 'searchResultsGrid');

                document.getElementById('searchResultsInfo').innerHTML = `
                    <span><i class="fas fa-music"></i> ${data.data.songs.length} songs</span>
                `;
            } else {
                document.getElementById('searchResultsGrid').innerHTML = '<div class="empty-state"><i class="fas fa-music"></i><p>No songs found in this playlist</p></div>';
                document.getElementById('searchResultsInfo').innerHTML = '';
            }
        }

        // Artist songs: pages start at 1, no sortBy / sortOrder / limit
        async function loadArtistSongs(artistId, artistName) {
            scrollToTop(false);

            showLoading('searchResultsGrid');
            switchTab('search-results');
            document.getElementById('searchResultsTitle').innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(artistName)}`;
            document.getElementById('loadMoreContainer').classList.remove('active');

            hideYouTubeSection();

            currentContext = {
                type: 'artist',
                id: artistId,
                name: artistName,
                songs: [],
                currentPage: 1,
                totalSongs: 0,
                hasMore: false,
                isLoading: false,
                loadedIds: new Set()
            };

            const data = await fetchAPI(`/artists/${artistId}/songs?page=1`);
            const songs = extractList(data);

            if (songs.length > 0) {
                currentContext.songs = songs;
                songs.forEach(s => currentContext.loadedIds.add(s.id));
                currentContext.totalSongs = data.data.total || songs.length;
                currentContext.hasMore = songs.length >= 10;

                displaySongs(songs, 'searchResultsGrid');

                const infoMsg = currentContext.totalSongs > songs.length
                    ? `Showing ${songs.length} of ${currentContext.totalSongs} songs`
                    : `Loaded ${songs.length} songs`;

                document.getElementById('searchResultsInfo').innerHTML = `
                    <span><i class="fas fa-music"></i> ${infoMsg}</span>
                `;

                if (currentContext.hasMore) {
                    document.getElementById('loadMoreContainer').classList.add('active');
                }
            } else {
                document.getElementById('searchResultsGrid').innerHTML = '<div class="empty-state"><i class="fas fa-music"></i><p>No songs found</p></div>';
                document.getElementById('searchResultsInfo').innerHTML = '';
            }
        }

        // ========== PLAYBACK ==========
        async function playSongFromData(song, songIndex = -1) {
            if (!song.downloadUrl?.length) {
                const songData = await fetchAPI(`/songs?id=${song.id}`);
                const fetched = Array.isArray(songData?.data)
                    ? songData.data[0]
                    : (songData?.data?.songs?.[0] || songData?.data?.results?.[0]);

                if (fetched) {
                    song = fetched;
                    if (songIndex >= 0 && currentContext.songs[songIndex]) {
                        currentContext.songs[songIndex] = song;
                    }
                }
            }
            playSong(song, songIndex);
        }

        function pickDownloadUrl(song, quality) {
            const list = song.downloadUrl || [];
            if (!list.length) return null;

            // Order from API: 12kbps, 48kbps, 96kbps, 160kbps, 320kbps
            const byQuality = { high: 4, medium: 3, low: 2 };
            const idx = byQuality[quality];
            if (idx !== undefined && list[idx]?.url) return list[idx].url;

            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i]?.url) return list[i].url;
            }
            return null;
        }

        function playSong(song, songIndex = -1) {
            currentSong = song;

            const downloadUrl = pickDownloadUrl(song, settings.audioQuality);

            if (downloadUrl) {
                audio.src = downloadUrl;
                audio.playbackRate = settings.playbackSpeed;
                audio.preload = 'auto';

                audio.play()
                    .then(() => {
                        isPlaying = true;
                        updatePlayPauseButtons();
                        updatePlayerUI();
                        updateFullscreenPlayerUI();
                        requestWakeLock();
                    })
                    .catch(err => {
                        console.error('Play error:', err);
                        isPlaying = false;
                        updatePlayPauseButtons();
                        showToast('Playback failed', 'error');
                    });

                addToRecentlyPlayed(song);
                setupMediaSession(song);
            } else {
                console.error('No download URL found');
                showToast('Song URL unavailable', 'error');
                return;
            }

            if (currentContext.type && currentContext.songs.length > 0) {
                queue = [...currentContext.songs];
                currentIndex = songIndex >= 0 ? songIndex : queue.findIndex(s => s.id === song.id);
            } else {
                if (!queue.find(s => s.id === song.id)) queue.push(song);
                currentIndex = queue.findIndex(s => s.id === song.id);
            }

            updatePlayerUI();
            updateFullscreenPlayerUI();
            updateQueueDisplay();
            updateBadges();
            updateStats();
        }

        function togglePlayPause(event) {
            if (event) event.stopPropagation();

            if (!currentSong) {
                showToast('No song selected', 'warning');
                return;
            }

            if (isPlaying) {
                audio.pause();
                isPlaying = false;
                updatePlayPauseButtons();
                releaseWakeLock();
            } else {
                audio.play()
                    .then(() => {
                        isPlaying = true;
                        updatePlayPauseButtons();
                        requestWakeLock();
                    })
                    .catch(err => {
                        console.error('Play failed:', err);
                        isPlaying = false;
                        updatePlayPauseButtons();
                        showToast('Playback failed', 'error');
                    });
            }
        }

        function updatePlayPauseButtons() {
            const icon = isPlaying ? 'pause' : 'play';
            ['playPauseBtn', 'playPauseBtnMini', 'fullscreenPlayPauseBtn'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.innerHTML = `<i class="fas fa-${icon}"></i>`;
            });
        }

        function previousSong() {
            if (currentIndex > 0) {
                currentIndex--;
                playSongFromData(queue[currentIndex], currentIndex);
                updateQueueDisplay();
            } else {
                showToast('First song in queue', 'info');
            }
        }

        function nextSong(event) {
            if (event) event.stopPropagation();

            if (queue.length === 0) {
                showToast('Queue is empty', 'warning');
                return;
            }

            if (repeatMode === 'all' && currentIndex === queue.length - 1) {
                currentIndex = 0;
                playSongFromData(queue[currentIndex], currentIndex);
            } else if (isShuffleOn && queue.length > 1) {
                let next = currentIndex;
                while (next === currentIndex) next = Math.floor(Math.random() * queue.length);
                currentIndex = next;
                playSongFromData(queue[currentIndex], currentIndex);
            } else if (currentIndex < queue.length - 1) {
                currentIndex++;
                playSongFromData(queue[currentIndex], currentIndex);
            } else {
                showToast('Last song in queue', 'info');
                audio.pause();
                isPlaying = false;
                updatePlayPauseButtons();
            }

            updateQueueDisplay();
        }

        // ========== QUEUE ==========
        function addToQueue(song) {
            if (!queue.find(s => s.id === song.id)) {
                queue.push(song);
                updateQueueDisplay();
                updateBadges();
                showToast('Added to queue', 'success');
            } else {
                showToast('Already in queue', 'info');
            }
        }

        function clearQueue() {
            if (confirm('Clear entire queue?')) {
                queue = [];
                currentIndex = -1;
                updateQueueDisplay();
                updateBadges();
                showToast('Queue cleared', 'success');
            }
        }

        function queueItemHTML(song, index) {
            const imageUrl = getImageUrl(song, 1);
            const artistName = getArtistNames(song);

            return `
                <div class="queue-item ${index === currentIndex ? 'active' : ''}" onclick="playFromQueue(${index})">
                    <img src="${imageUrl}" class="queue-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                    <div class="queue-info">
                        <div class="title">${song.name || 'Unknown Song'}</div>
                        <div class="artist">${artistName}</div>
                    </div>
                    <button class="icon-btn" onclick="removeFromQueue(${index}, event)">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        }

        function updateQueueDisplay() {
            const queueList = document.getElementById('queueList');
            const queueCount = document.getElementById('queueCount');

            if (queueCount) queueCount.textContent = queue.length;

            if (!queue.length) {
                if (queueList) queueList.innerHTML = '<div class="empty-state"><i class="fas fa-list"></i><p>Queue is empty</p></div>';
                updateFullscreenQueue();
                return;
            }

            if (queueList) {
                queueList.innerHTML = queue.map((song, index) => queueItemHTML(song, index)).join('');
            }

            updateFullscreenQueue();
        }

        function playFromQueue(index) {
            currentIndex = index;
            playSongFromData(queue[index], index);
            updateQueueDisplay();
        }

        function removeFromQueue(index, event) {
            event.stopPropagation();
            queue.splice(index, 1);
            if (currentIndex >= index && currentIndex > 0) currentIndex--;
            updateQueueDisplay();
            updateBadges();
        }

        function toggleShuffle() {
            isShuffleOn = !isShuffleOn;
            const btn = document.getElementById('shuffleBtn');
            const fullscreenBtn = document.getElementById('fullscreenShuffleBtn');

            if (btn) btn.classList.toggle('active', isShuffleOn);
            if (fullscreenBtn) fullscreenBtn.classList.toggle('active', isShuffleOn);

            showToast(isShuffleOn ? 'Shuffle on' : 'Shuffle off', 'info');
        }

        function toggleRepeat() {
            const modes = ['off', 'all', 'one'];
            repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];

            const btn = document.getElementById('repeatBtn');
            const fullscreenBtn = document.getElementById('fullscreenRepeatBtn');

            const apply = (el, bottom) => {
                if (!el) return;
                el.classList.toggle('active', repeatMode !== 'off');
                el.innerHTML = repeatMode === 'one'
                    ? `<i class="fas fa-redo"></i><span style="font-size: 0.6rem; position: absolute; bottom: ${bottom}px; right: ${bottom}px;">1</span>`
                    : '<i class="fas fa-redo"></i>';
            };

            apply(btn, 8);
            apply(fullscreenBtn, 12);

            showToast(`Repeat: ${repeatMode}`, 'info');
        }

        function togglePlayerExpand() {
            if (event.target.closest('.player-mini-controls')) return;

            playerExpanded = !playerExpanded;
            const playerFull = document.getElementById('playerFull');
            if (playerFull) playerFull.classList.toggle('active');
        }

        function updatePlayerUI(isLoading = false) {
            if (!currentSong) return;

            const imageUrl = getImageUrl(currentSong, 2);
            const artistName = getArtistNames(currentSong);

            const playerImg = document.getElementById('playerImgMini');
            const playerTitle = document.getElementById('playerTitleMini');
            const playerArtist = document.getElementById('playerArtistMini');

            if (playerImg) {
                playerImg.src = imageUrl;
                playerImg.classList.toggle('loading', isLoading);
            }

            if (playerTitle) {
                playerTitle.textContent = currentSong.name || 'Unknown Song';
                if (playerTitle.parentElement) playerTitle.parentElement.classList.toggle('loading', isLoading);
            }

            if (playerArtist) playerArtist.textContent = artistName;

            updateFavoriteIcon();
        }

        function updateFullscreenPlayerUI(isLoading = false) {
            if (!currentSong) return;

            const imageUrl = getImageUrl(currentSong, 2);
            const artistName = getArtistNames(currentSong);

            const fullscreenImg = document.getElementById('fullscreenImg');
            const fullscreenTitle = document.getElementById('fullscreenTitle');
            const fullscreenArtist = document.getElementById('fullscreenArtist');

            if (fullscreenImg) {
                fullscreenImg.src = imageUrl;
                fullscreenImg.classList.toggle('loading', isLoading);
            }

            if (fullscreenTitle) fullscreenTitle.textContent = currentSong.name || 'Unknown Song';
            if (fullscreenArtist) fullscreenArtist.textContent = artistName;

            const isFav = favorites.find(f => f.id === currentSong.id);
            const fullscreenFavIcon = document.getElementById('fullscreenFavoriteIcon');
            if (fullscreenFavIcon) {
                fullscreenFavIcon.className = isFav ? 'fas fa-heart' : 'far fa-heart';
                fullscreenFavIcon.style.color = isFav ? 'var(--accent-primary)' : '';
            }

            const shuffleBtn = document.getElementById('fullscreenShuffleBtn');
            const repeatBtn = document.getElementById('fullscreenRepeatBtn');

            if (shuffleBtn) shuffleBtn.classList.toggle('active', isShuffleOn);

            if (repeatBtn) {
                repeatBtn.classList.toggle('active', repeatMode !== 'off');
                repeatBtn.innerHTML = repeatMode === 'one'
                    ? '<i class="fas fa-redo"></i><span style="font-size: 0.6rem; position: absolute; bottom: 12px; right: 12px;">1</span>'
                    : '<i class="fas fa-redo"></i>';
            }
        }

        function toggleFullscreenQueue() {
            if (window.innerWidth < 1024) {
                const player = document.getElementById('fullscreenPlayer');
                if (player) player.classList.toggle('queue-open');
                updateFullscreenQueue();
            }
        }

        function updateFullscreenQueue() {
            const queueList = document.getElementById('fullscreenQueueList');
            if (!queueList) return;

            if (!queue.length) {
                queueList.innerHTML = '<div class="empty-state"><i class="fas fa-list"></i><p>Queue is empty</p></div>';
                return;
            }

            queueList.innerHTML = queue.map((song, index) => queueItemHTML(song, index)).join('');
        }

        function seekSongFullscreen(event) {
            if (!audio.duration) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const percent = (event.clientX - rect.left) / rect.width;
            audio.currentTime = percent * audio.duration;
        }

        function updateProgress() {
            if (audio.duration) {
                const percent = (audio.currentTime / audio.duration) * 100;
                const progressFilled = document.getElementById('progressFilled');
                const currentTime = document.getElementById('currentTime');

                if (progressFilled) progressFilled.style.width = percent + '%';
                if (currentTime) currentTime.textContent = formatTime(audio.currentTime);

                const fullscreenFilled = document.getElementById('fullscreenProgressFilled');
                const fullscreenTime = document.getElementById('fullscreenCurrentTime');
                const fullscreenDur = document.getElementById('fullscreenDuration');

                if (fullscreenFilled) fullscreenFilled.style.width = percent + '%';
                if (fullscreenTime) fullscreenTime.textContent = formatTime(audio.currentTime);
                if (fullscreenDur) fullscreenDur.textContent = formatTime(audio.duration);
            }
        }

        function seekSong(event) {
            if (!audio.duration) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const percent = (event.clientX - rect.left) / rect.width;
            audio.currentTime = percent * audio.duration;
        }

        function setVolume(event) {
            const rect = event.currentTarget.getBoundingClientRect();
            const percent = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
            audio.volume = percent;
            const volumeFilled = document.getElementById('volumeFilled');
            if (volumeFilled) volumeFilled.style.width = (percent * 100) + '%';
        }

        // ========== DOWNLOAD / SHARE ==========
        function downloadSong(song) {
            const downloadUrl = song.downloadUrl?.[4]?.url
                || song.downloadUrl?.[3]?.url
                || song.downloadUrl?.[2]?.url
                || song.downloadUrl?.[song.downloadUrl.length - 1]?.url;

            if (downloadUrl) {
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = `${song.name}.mp3`;
                a.target = '_blank';
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
                showToast('Download started', 'success');
            } else {
                showToast('Download unavailable', 'error');
            }
        }

        function downloadCurrentSong() {
            if (currentSong) downloadSong(currentSong);
            else showToast('No song playing', 'warning');
        }

        function shareCurrentSong() {
            if (!currentSong) {
                showToast('No song playing', 'warning');
                return;
            }

            const shareText = `🎵 ${currentSong.name} - ${getArtistNames(currentSong, '')}`;

            if (navigator.share) {
                navigator.share({
                    title: currentSong.name,
                    text: shareText,
                    url: currentSong.url || window.location.href
                }).then(() => {
                    showToast('Shared successfully', 'success');
                }).catch(() => {
                    copyToClipboard(shareText);
                });
            } else {
                copyToClipboard(shareText);
            }
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('Copied to clipboard', 'success');
            });
        }

        // ========== FAVORITES ==========
        function toggleFavorite(event) {
            event.stopPropagation();
            if (!currentSong) return;
            toggleFavoriteSong(currentSong);
        }

        function toggleFavoriteSong(song) {
            const index = favorites.findIndex(f => f.id === song.id);
            if (index > -1) {
                favorites.splice(index, 1);
                showToast('Removed from favorites', 'info');
            } else {
                favorites.push(song);
                showToast('Added to favorites', 'success');
            }
            localStorage.setItem('favorites', JSON.stringify(favorites));
            updateFavoriteIcon();
            updateBadges();
            updateStats();
            updateFullscreenPlayerUI();
        }

        function updateFavoriteIcon() {
            const isFav = currentSong && favorites.find(f => f.id === currentSong.id);
            const icon = document.getElementById('favoriteIcon');
            if (icon) {
                icon.className = isFav ? 'fas fa-heart' : 'far fa-heart';
                icon.style.color = isFav ? 'var(--accent-primary)' : '';
            }

            const fullscreenIcon = document.getElementById('fullscreenFavoriteIcon');
            if (fullscreenIcon) {
                fullscreenIcon.className = isFav ? 'fas fa-heart' : 'far fa-heart';
                fullscreenIcon.style.color = isFav ? 'var(--accent-primary)' : '';
            }
        }

        function openFavorites() {
            displayFavorites();
            openModal('favoritesModal');
        }

        function displayFavorites() {
            const list = document.getElementById('favoritesList');
            if (!list) return;

            if (!favorites.length) {
                list.innerHTML = '<div class="empty-state"><i class="fas fa-heart"></i><p>No favorites yet</p></div>';
                return;
            }

            list.innerHTML = favorites.map(song => `
                <div class="queue-item" onclick="playSongFromFavorites('${attrStr(song.id)}')">
                    <img src="${getImageUrl(song, 1)}" class="queue-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                    <div class="queue-info">
                        <div class="title">${song.name}</div>
                        <div class="artist">${getArtistNames(song)}</div>
                    </div>
                    <button class="icon-btn" onclick="removeFavorite('${attrStr(song.id)}', event)">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `).join('');
        }

        function playSongFromFavorites(songId) {
            const song = favorites.find(s => s.id === songId);
            if (song) {
                playSongFromData(song);
                closeModal('favoritesModal');
            }
        }

        function removeFavorite(songId, event) {
            event.stopPropagation();
            favorites = favorites.filter(f => f.id !== songId);
            localStorage.setItem('favorites', JSON.stringify(favorites));
            displayFavorites();
            updateBadges();
            updateStats();
        }

        // ========== RECENTLY PLAYED ==========
        function addToRecentlyPlayed(song) {
            const index = recentlyPlayed.findIndex(s => s.id === song.id);
            if (index > -1) recentlyPlayed.splice(index, 1);
            recentlyPlayed.unshift(song);
            recentlyPlayed = recentlyPlayed.slice(0, 50);
            localStorage.setItem('recentlyPlayed', JSON.stringify(recentlyPlayed));
            updateBadges();
        }

        function openRecentlyPlayed() {
            displayRecentlyPlayed();
            openModal('recentModal');
        }

        function displayRecentlyPlayed() {
            const list = document.getElementById('recentList');
            if (!list) return;

            if (!recentlyPlayed.length) {
                list.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><p>No recent songs</p></div>';
                return;
            }

            list.innerHTML = recentlyPlayed.map(song => `
                <div class="queue-item" onclick="playSongFromRecent('${attrStr(song.id)}')">
                    <img src="${getImageUrl(song, 1)}" class="queue-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                    <div class="queue-info">
                        <div class="title">${song.name}</div>
                        <div class="artist">${getArtistNames(song)}</div>
                    </div>
                </div>
            `).join('');
        }

        function playSongFromRecent(songId) {
            const song = recentlyPlayed.find(s => s.id === songId);
            if (song) {
                playSongFromData(song);
                closeModal('recentModal');
            }
        }

        // ========== USER PLAYLISTS ==========
        function showCreatePlaylist() {
            closeModal('playlistModal');
            openModal('createPlaylistModal');
        }

        function createPlaylist() {
            const name = document.getElementById('playlistName').value.trim();
            const desc = document.getElementById('playlistDesc').value.trim();

            if (name) {
                playlists.push({
                    id: Date.now().toString(),
                    name: name,
                    description: desc,
                    songs: [],
                    createdAt: new Date().toISOString()
                });
                savePlaylists();
                document.getElementById('playlistName').value = '';
                document.getElementById('playlistDesc').value = '';
                closeModal('createPlaylistModal');
                updateMyPlaylistsDisplay();
                updateStats();
                showToast('Playlist created', 'success');
            } else {
                showToast('Enter playlist name', 'warning');
            }
        }

        function openAddToPlaylist() {
            if (!currentSong && !currentPlaylistForAdd) {
                showToast('No song selected', 'warning');
                return;
            }

            if (!playlists.length) {
                showToast('Create a playlist first', 'info');
                showCreatePlaylist();
                return;
            }

            const list = document.getElementById('addToPlaylistList');
            if (list) {
                list.innerHTML = playlists.map(playlist => `
                    <div class="playlist-item" onclick="addToPlaylistAction('${playlist.id}')">
                        <div>
                            <div style="font-weight: 600; font-size: 0.85rem;">${playlist.name}</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">${playlist.songs.length} songs</div>
                        </div>
                        <i class="fas fa-chevron-right"></i>
                    </div>
                `).join('');
            }

            openModal('addToPlaylistModal');
        }

        function addToPlaylistAction(playlistId) {
            const playlist = playlists.find(p => p.id === playlistId);
            const songToAdd = currentPlaylistForAdd || currentSong;

            if (playlist && songToAdd) {
                if (!playlist.songs.find(s => s.id === songToAdd.id)) {
                    playlist.songs.push(songToAdd);
                    savePlaylists();
                    updateMyPlaylistsDisplay();
                    showToast('Added to playlist', 'success');
                } else {
                    showToast('Already in playlist', 'info');
                }
            }
            closeModal('addToPlaylistModal');
            currentPlaylistForAdd = null;
        }

        function updateMyPlaylistsDisplay() {
            const grid = document.getElementById('myPlaylistsGrid');
            if (!grid) return;

            if (!playlists.length) {
                grid.innerHTML = '<div class="empty-state"><i class="fas fa-heart"></i><p>No playlists yet</p></div>';
                return;
            }

            grid.innerHTML = playlists.map(playlist => {
                const firstSongImage = playlist.songs[0] ? getImageUrl(playlist.songs[0], 1) : null;
                const hasImage = firstSongImage && firstSongImage !== PLACEHOLDER_IMG;

                return `
                <div class="card">
                    <div class="card-img-container" style="${hasImage ? `background-image: url('${firstSongImage}'); background-size: cover;` : 'background: var(--accent-gradient);'} display: flex; align-items: center; justify-content: center;">
                        ${!hasImage ? '<i class="fas fa-music" style="font-size: 2.5rem; color: white; opacity: 0.8;"></i>' : ''}
                        <div class="play-overlay" onclick="event.stopPropagation(); playUserPlaylistById('${playlist.id}')">
                            <i class="fas fa-play"></i>
                        </div>
                    </div>
                    <div class="card-title">${playlist.name}</div>
                    <div class="card-subtitle">${playlist.songs.length} songs</div>
                    <div class="card-actions">
                        <button class="icon-btn" onclick="event.stopPropagation(); viewUserPlaylistById('${playlist.id}')" title="View">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="icon-btn" onclick="event.stopPropagation(); playUserPlaylistById('${playlist.id}')" title="Play">
                            <i class="fas fa-play"></i>
                        </button>
                        <button class="icon-btn" onclick="event.stopPropagation(); deletePlaylist('${playlist.id}')" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `}).join('');
        }

        function viewUserPlaylistById(id) {
            const playlist = playlists.find(p => p.id === id);
            if (playlist) viewUserPlaylist(playlist);
        }

        function playUserPlaylistById(id) {
            const playlist = playlists.find(p => p.id === id);
            if (playlist) playUserPlaylist(playlist);
        }

        function viewUserPlaylist(playlist) {
            closeModal('playlistModal');
            const viewPlaylistTitle = document.getElementById('viewPlaylistTitle');
            if (viewPlaylistTitle) viewPlaylistTitle.textContent = playlist.name;

            const container = document.getElementById('viewPlaylistSongs');
            if (!container) return;

            if (!playlist.songs.length) {
                container.innerHTML = '<div class="empty-state"><i class="fas fa-music"></i><p>No songs in playlist</p></div>';
            } else {
                container.innerHTML = playlist.songs.map((song, index) => `
                    <div class="queue-item" onclick="playSongFromMyPlaylist('${playlist.id}', ${index})">
                        <img src="${getImageUrl(song, 1)}" class="queue-img" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                        <div class="queue-info">
                            <div class="title">${song.name}</div>
                            <div class="artist">${getArtistNames(song)}</div>
                        </div>
                        <button class="icon-btn" onclick="removeSongFromPlaylist('${playlist.id}', ${index}, event)">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `).join('');
            }

            openModal('viewPlaylistModal');
        }

        function playSongFromMyPlaylist(playlistId, songIndex) {
            const playlist = playlists.find(p => p.id === playlistId);
            if (playlist && playlist.songs[songIndex]) {
                currentContext = {
                    type: 'myplaylist',
                    id: playlistId,
                    name: playlist.name,
                    songs: playlist.songs,
                    currentPage: 0,
                    totalSongs: playlist.songs.length,
                    hasMore: false,
                    isLoading: false
                };

                queue = [...playlist.songs];
                currentIndex = songIndex;
                playSongFromData(playlist.songs[songIndex], songIndex);
                closeModal('viewPlaylistModal');
            }
        }

        function playUserPlaylist(playlist) {
            if (!playlist.songs.length) {
                showToast('Playlist is empty', 'warning');
                return;
            }

            currentContext = {
                type: 'myplaylist',
                id: playlist.id,
                name: playlist.name,
                songs: playlist.songs,
                currentPage: 0,
                totalSongs: playlist.songs.length,
                hasMore: false,
                isLoading: false
            };

            queue = [...playlist.songs];
            currentIndex = 0;
            playSongFromData(queue[0], 0);
            closeModal('playlistModal');
            switchTab('queue');
        }

        function deletePlaylist(id) {
            if (confirm('Delete this playlist?')) {
                playlists = playlists.filter(p => p.id !== id);
                savePlaylists();
                updateMyPlaylistsDisplay();
                updateStats();
                showToast('Playlist deleted', 'success');
            }
        }

        function removeSongFromPlaylist(playlistId, songIndex, event) {
            event.stopPropagation();
            const playlist = playlists.find(p => p.id === playlistId);
            if (playlist) {
                playlist.songs.splice(songIndex, 1);
                savePlaylists();
                viewUserPlaylist(playlist);
                updateMyPlaylistsDisplay();
            }
        }

        function savePlaylists() {
            localStorage.setItem('playlists', JSON.stringify(playlists));
        }

        // ========== SETTINGS ==========
        function openSettings() {
            openModal('settingsModal');
        }

        function loadSettings() {
            const audioQuality = document.getElementById('audioQuality');
            const playbackSpeed = document.getElementById('playbackSpeed');

            if (audioQuality) audioQuality.value = settings.audioQuality;
            if (playbackSpeed) playbackSpeed.value = settings.playbackSpeed;
        }

        function saveSettings() {
            const audioQuality = document.getElementById('audioQuality');
            if (audioQuality) settings.audioQuality = audioQuality.value;

            localStorage.setItem('settings', JSON.stringify(settings));
            showToast('Settings saved', 'success');
        }

        function changePlaybackSpeed() {
            const playbackSpeed = document.getElementById('playbackSpeed');
            if (playbackSpeed) {
                settings.playbackSpeed = parseFloat(playbackSpeed.value);
                audio.playbackRate = settings.playbackSpeed;
                saveSettings();
            }
        }

        function clearAllData() {
            if (confirm('This will delete all your data. Continue?')) {
                localStorage.clear();
                location.reload();
            }
        }

        // ========== FULLSCREEN PLAYER ==========
        function openFullscreenPlayer() {
            if (!currentSong) return;
            updatePlayerUI();
            updateFullscreenPlayerUI();
            updateFullscreenQueue();

            const player = document.getElementById('fullscreenPlayer');
            if (player) {
                player.classList.add('active');
                if (window.innerWidth >= 1024) player.classList.add('queue-open');
            }

            document.body.style.overflow = 'hidden';
        }

        function closeFullscreenPlayer() {
            const player = document.getElementById('fullscreenPlayer');
            if (player) {
                player.classList.remove('active');
                player.classList.remove('queue-open');
            }
            document.body.style.overflow = '';
        }

        // ========== TABS / MODALS ==========
        function switchTab(tabName) {
            scrollToTop(false);

            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));

            document.querySelectorAll('.tab').forEach(tab => {
                const tabText = tab.textContent.toLowerCase().trim();
                const targetText = tabName.toLowerCase().replace('-', ' ').trim();
                if (tabText.includes(targetText.split(' ')[0])) {
                    tab.classList.add('active');
                }
            });

            const section = document.getElementById(tabName);
            if (section) section.classList.add('active');

            if (tabName === 'trending-playlists' && !document.getElementById('trendingPlaylistsGrid').innerHTML) {
                loadTrendingPlaylists();
            } else if (tabName === 'trending-albums' && !document.getElementById('trendingAlbumsGrid').innerHTML) {
                loadTrendingAlbums();
            } else if (tabName === 'queue') {
                updateQueueDisplay();
            } else if (tabName === 'my-playlists') {
                updateMyPlaylistsDisplay();
            }
        }

        function openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove('active');
            document.body.style.overflow = '';
        }

        function updateBadges() {
            const setBadge = (id, count) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (count > 0) {
                    el.textContent = count;
                    el.style.display = 'block';
                } else {
                    el.style.display = 'none';
                }
            };

            setBadge('queueBadge', queue.length);
            setBadge('sidebarQueueBadge', queue.length);
            setBadge('sidebarFavBadge', favorites.length);
            setBadge('sidebarRecentBadge', recentlyPlayed.length);
            setBadge('sidebarPlaylistBadge', playlists.length);
        }

        function updateStats() {
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };

            set('statSongs', recentlyPlayed.length);
            set('statPlaylists', playlists.length);
            set('statFavorites', favorites.length);
            set('sidebarStatSongs', recentlyPlayed.length);
            set('sidebarStatPlaylists', playlists.length);
            set('sidebarStatFavorites', favorites.length);
        }

        function formatTime(seconds) {
            seconds = Number(seconds);
            if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }

        function showLoading(gridId) {
            showSkeletonLoader(gridId, 6);
        }

        function showToast(message, type = 'info') {
            const icons = {
                success: 'fa-check-circle',
                error: 'fa-exclamation-circle',
                warning: 'fa-exclamation-triangle',
                info: 'fa-info-circle'
            };

            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);
        }

        function openMobileSearch() {
            const modal = document.getElementById('mobileSearchModal');
            if (modal) modal.classList.add('active');
            document.body.style.overflow = 'hidden';
            setTimeout(() => {
                const searchInput = document.getElementById('searchInputMobile');
                if (searchInput) searchInput.focus();
            }, 300);
        }

        function closeMobileSearch() {
            const modal = document.getElementById('mobileSearchModal');
            if (modal) modal.classList.remove('active');
            document.body.style.overflow = '';
        }

        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            const icon = document.getElementById('themeIcon');

            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);

            if (icon) icon.className = newTheme === 'light' ? 'fas fa-moon' : 'fas fa-sun';

            showToast(`${newTheme === 'light' ? 'Light' : 'Dark'} theme activated`, 'success');
        }

        // ========== EVENT LISTENERS ==========
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', function(e) {
                if (e.target === this) closeModal(this.id);
            });
        });

        document.addEventListener('click', function(e) {
            const modal = document.getElementById('mobileSearchModal');
            if (modal && modal.classList.contains('active')) {
                if (e.target.classList.contains('mobile-search-overlay')) closeMobileSearch();
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            if (e.key === 'Escape') {
                const sidebar = document.getElementById('sidebar');
                if (sidebar && sidebar.classList.contains('active')) closeSidebar();
            }

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    togglePlayPause();
                    break;
                case 'ArrowRight':
                    nextSong();
                    break;
                case 'ArrowLeft':
                    previousSong();
                    break;
            }
        });

        // ========== SKELETON LOADER ==========
        function generateSkeletonCards(count = 6) {
            return Array.from({ length: count }, () => `
                <div class="skeleton-card">
                    <div class="skeleton-img"></div>
                    <div class="skeleton-title"></div>
                    <div class="skeleton-subtitle"></div>
                </div>
            `).join('');
        }

        function showSkeletonLoader(gridId, count = 6) {
            const grid = document.getElementById(gridId);
            if (grid) {
                grid.className = 'skeleton-grid';
                grid.innerHTML = generateSkeletonCards(count);
            }
        }

        // ========== SCROLL ==========
        function scrollToTop(smooth = true) {
            if (smooth) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                window.scrollTo(0, 0);
            }
        }

        function scrollContainerToTop() {
            const container = document.querySelector('.container');
            if (container) container.scrollTop = 0;
            scrollToTop(false);
        }
