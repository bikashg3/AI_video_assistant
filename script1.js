// Constants and Configuration
const USER_SPEECH_INTERRUPT_DELAY = 500;
const TEXT_TO_SPEECH_API_ENDPOINT = "https://api.streamelements.com/kappa/v2/speech";
const CHUNK_SIZE = 300;
const MAX_PREFETCH_REQUESTS = 10;
const PREFETCH_CACHE_EXPIRATION = 60000; // 1 minute
const AUDIO_CACHE_EXPIRATION = 3600000; // 1 hour
const WEBCAM_INTERVAL = 5000;
const MAX_HISTORY_LENGTH = 6;

// DOM Elements
const startStopButton = document.getElementById('startStopButton');
const voiceSelectionDropdown = document.getElementById('voiceSelect');
const modelSelectionDropdown = document.getElementById('modelSelect');
const noiseSuppressionCheckbox = document.getElementById('noiseSuppression');
const responseTimeDisplay = document.getElementById('responseTime');
const userActivityIndicator = document.getElementById('userIndicator');
const aiActivityIndicator = document.getElementById('aiIndicator');
const transcriptDiv = document.getElementById('transcript');
const video = document.getElementById('webcam');

// Speech Recognition
let speechRecognizer;
let isSpeechRecognitionActive = false;

// AI Interaction State
let activeQuery = null;
let queryStartTime = 0;
let isRequestInProgress = false;
let isUserSpeaking = false;
let requestAbortController = null;
let firstResponseTextTimestamp = null;
let lastUserSpeechTimestamp = 0;

// Audio Management
let currentAudio = null;
let audioPlaybackQueue = [];

// Prefetching and Caching
const prefetchCache = new Map();
const pendingPrefetchRequests = new Map();
const prefetchQueue = [];
let prefetchTextQuery = "";

// Conversation History
let conversationHistory = [];

// Audio Caching
const audioCache = new Map();

// Image Captioning State
let isCaptioningEnabled = false;
let lastCaption = "";

// Webcam Integration
import { client, handle_file } from 'https://cdn.jsdelivr.net/npm/@gradio/client/+esm';
const clients = [
    "multimodalart/Florence-2-l4",
    "gokaygokay/Florence-2",
    "multimodalart/Florence-2-l4-2",
    "gokaygokay/Florence-2",
];
let app;
let webcamInterval;


// Utility Functions

// Normalize query text 
const normalizeQueryText = query => query.trim().toLowerCase().replace(/[^\w\s]/g, '');

// Generate a cache key
const generateCacheKey = (normalizedQuery, voice, history, modelName) =>
    `${normalizedQuery}-${voice}-${JSON.stringify(history)}-${modelName}`;

// Update activity indicators
const updateActivityIndicators = (state = null) => {
    userActivityIndicator.textContent = isUserSpeaking ? "User: Speaking" : "User: Idle";

    if (isRequestInProgress && !currentAudio) {
        aiActivityIndicator.textContent = "AI: Processing...";
    } else if (currentAudio && !isUserSpeaking) {
        aiActivityIndicator.textContent = state || "AI: Speaking";
    } else if (isUserSpeaking) {
        aiActivityIndicator.textContent = "AI: Listening";
    } else {
        aiActivityIndicator.textContent = "AI: Idle";
    }
};

// Update latency display
const updateLatency = () => {
    if (firstResponseTextTimestamp) {
        const latency = firstResponseTextTimestamp - queryStartTime;
        responseTimeDisplay.textContent = `Latency: ${latency}ms`;
    } else {
        responseTimeDisplay.textContent = "Latency: 0ms";
    }
};

// Add to conversation history
const addToConversationHistory = (role, content) => {
    conversationHistory.push({ role, content });
    if (conversationHistory.length > MAX_HISTORY_LENGTH) {
        conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
    }
};

// Check if audio playback should be interrupted
const shouldInterruptAudioPlayback = (interimTranscript) =>
    Date.now() - lastUserSpeechTimestamp > USER_SPEECH_INTERRUPT_DELAY || interimTranscript.length > 5;


// Audio Management Functions

// Play audio from the queue
const playNextAudio = async () => {
    if (audioPlaybackQueue.length > 0) {
        const audioData = audioPlaybackQueue.shift();
        const audio = new Audio(audioData.url);
        updateActivityIndicators();

        const audioPromise = new Promise(resolve => {
            audio.onended = resolve;
            audio.onerror = resolve;
        });
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }

        currentAudio = audio;
        await audio.play();
        await audioPromise;
        playNextAudio();
    } else {
        updateActivityIndicators();
    }
};

// Interrupt audio playback
const interruptAudioPlayback = (reason = 'unknown') => {
    console.log(`Interrupting audio (reason: ${reason})...`);
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }

    audioPlaybackQueue.length = 0;
    isRequestInProgress = false;

    if (requestAbortController) {
        requestAbortController.abort();
        requestAbortController = null;
    }

    // Clear prefetch cache and queue only if the interruption is due to user speech
    if (reason === 'user is speaking' || reason === 'interim') {
        prefetchCache.clear();
        prefetchQueue.length = 0; 
    }

    updateActivityIndicators();
};


// Prefetching and Caching Functions

// Prefetch and cache the first TTS audio chunk
const prefetchFirstAudioChunk = (query, voice) => {
    let combinedQuery = `{USER: "${query}"}`;
    if (lastCaption !== "") {
        combinedQuery += `, ${lastCaption} , {USER: "${query}"}`;
    }
    const normalizedQuery = normalizeQueryText(combinedQuery); // Normalize combined query
    const cacheKey = generateCacheKey(normalizedQuery, voice, conversationHistory, modelSelectionDropdown.value);

    if (pendingPrefetchRequests.has(cacheKey) || prefetchCache.has(cacheKey)) return;

    prefetchQueue.push({ query: combinedQuery.trim(), voice, cacheKey }); // Use combined query
    processPrefetchQueue();
};

// Process the prefetch queue
const processPrefetchQueue = async () => {
    while (prefetchQueue.length > 0 && pendingPrefetchRequests.size < MAX_PREFETCH_REQUESTS) {
        const { query, voice, cacheKey } = prefetchQueue.shift();
        const abortController = new AbortController();
        pendingPrefetchRequests.set(cacheKey, abortController);

        try {
            const firstAudioUrl = await streamAndPrefetchAudio(query, voice, abortController.signal);

            if (firstAudioUrl) prefetchCache.set(cacheKey, { url: firstAudioUrl, timestamp: Date.now() });

        } catch (error) {
            if (error.name !== 'AbortError') console.error("Error prefetching audio:", error);
        } finally {
            pendingPrefetchRequests.delete(cacheKey);
            processPrefetchQueue();
        }
    }
};

// Cancel pending prefetch requests
const cancelPrefetchRequests = (query) => {
    let combinedQuery = `{USER: "${query}"}`;
    if (lastCaption !== "") {
        combinedQuery += `, ${lastCaption} , {USER: "${query}"}`;
    }
    const normalizedQuery = normalizeQueryText(combinedQuery); // Normalize combined query

    for (const [cacheKey, abortController] of pendingPrefetchRequests) {
        if (cacheKey.startsWith(normalizedQuery)) {
            abortController.abort();
            pendingPrefetchRequests.delete(cacheKey);
        }
    }
};


// AI Interaction Functions

// Send a query to the AI
async function sendQueryToAI(query) {
    isRequestInProgress = true;
    updateActivityIndicators();
    firstResponseTextTimestamp = null;
    queryStartTime = Date.now();
    requestAbortController = new AbortController();


    const cacheKey = generateCacheKey(query, voiceSelectionDropdown.value, conversationHistory, modelSelectionDropdown.value);

    try {
        let combinedQuery = `{USER: "${query}"}`;
        if (lastCaption !== "") {
            combinedQuery += `, ${lastCaption} , {USER: "${query}"}`;
        }

        await streamAndHandleAudioResponse(combinedQuery, voiceSelectionDropdown.value, requestAbortController.signal);
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Error sending query to AI:", error);
        }
    } finally {
        isRequestInProgress = false;
        updateActivityIndicators();
    }
};

// Process the final speech transcript
const processSpeechTranscript = (transcript) => {
    const trimmedTranscript = transcript.trimStart();
    if (trimmedTranscript !== '' && !isRequestInProgress) {
        activeQuery = trimmedTranscript;
        addToConversationHistory('user', activeQuery);
        sendQueryToAI(activeQuery);
    }
};


// Network and Streaming Functions

// Stream AI response and handle audio
const streamAndHandleAudioResponse = async (query, voice, abortSignal) => {
    const response = await fetchAIResponse(query, abortSignal);

    if (!response.ok) {
        if (response.status === 429) {
            console.log("Rate limit hit, retrying in 1 second...");
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sendQueryToAI(query);
            return;
        }
        throw new Error(`Network response was not ok: ${response.status}`);
    }

    console.log("Streaming audio response received");
    await handleStreamingResponse(response.body, voice, abortSignal);
};

// Stream AI response for prefetching
const streamAndPrefetchAudio = async (query, voice, abortSignal) => {
    const response = await fetchAIResponse(query, abortSignal);

    if (!response.ok) throw new Error('Network response was not ok');

    return handleStreamingResponseForPrefetch(response.body, voice, abortSignal);
};

// Fetch AI response 
const fetchAIResponse = async (query, abortSignal) => {
    const userSambanovaKey = document.getElementById('apiKey').value.trim() !== '' ? document.getElementById('apiKey').value.trim() : 'none';

    const url = '/stream_text';
    const requestBody = {
        query: query,
        history: JSON.stringify(conversationHistory),
        model: modelSelectionDropdown.value,
        api_key: userSambanovaKey
    };

    return fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal
    });
};

// Handle the streaming response for prefetching
const handleStreamingResponseForPrefetch = async (responseStream, voice, abortSignal) => {
    const reader = responseStream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abortSignal.aborted) throw new DOMException('Request aborted', 'AbortError');

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split('\n');

            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i];
                if (line.startsWith('data: ')) {
                    const textContent = line.substring(6).trim();
                    if (textContent) {
                        return await generateTextToSpeechAudio(textContent, voice);
                    }
                }
            }

            buffer = lines[lines.length - 1];
        }
    } catch (error) {
        console.error("Error in handleStreamingResponseForPrefetch:", error);
    } finally {
        reader.releaseLock();
    }

    return null;
};

// Handle the streaming audio response
const handleStreamingResponse = async (responseStream, voice, abortSignal) => {
    const reader = responseStream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullResponseText = "";
    let fullResponseText2 = "";
    let textChunk = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abortSignal.aborted) throw new DOMException('Request aborted', 'AbortError');

            if (isUserSpeaking) {
                interruptAudioPlayback('user is speaking');
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const textContent = line.substring(6).trim();
                    if (textContent) {
                        if (!firstResponseTextTimestamp) firstResponseTextTimestamp = Date.now();

                        fullResponseText += textContent + " ";
                        fullResponseText2 += textContent + " ";
                        textChunk += textContent + " ";
                        transcriptDiv.textContent = fullResponseText2;


                        if (textChunk.length >= CHUNK_SIZE) {
                            const audioUrl = await generateTextToSpeechAudio(textChunk, voice);
                            if (audioUrl) {
                                audioPlaybackQueue.push({ url: audioUrl });
                                if (!currentAudio) playNextAudio();
                            }
                            textChunk = "";
                        }
                    }
                }
            }

            buffer = lines[lines.length - 1];
        }
    } catch (error) {
        console.error("Error in handleStreamingResponse:", error);
    } finally {
        reader.releaseLock();

        if (textChunk !== "") { // Send any remaining text
            const audioUrl = await generateTextToSpeechAudio(textChunk, voice);
            if (audioUrl) {
                audioPlaybackQueue.push({ url: audioUrl });
                if (!currentAudio) playNextAudio();
            }
        }

        addToConversationHistory('assistant', fullResponseText2);
        fullResponseText = "";
        fullResponseText2 = "";
    }
};

// Generate Text-to-Speech audio with caching
const generateTextToSpeechAudio = async (text, voice) => {
    const normalizedText = normalizeQueryText(text);
    const cacheKey = `${normalizedText}-${voice}`;

    if (audioCache.has(cacheKey)) {
        const cachedData = audioCache.get(cacheKey);
        if (Date.now() - cachedData.timestamp < AUDIO_CACHE_EXPIRATION) {
            return cachedData.url;
        } else {
            audioCache.delete(cacheKey);
        }
    }

    try {
        const response = await fetch(`${TEXT_TO_SPEECH_API_ENDPOINT}?voice=${voice}&text=${encodeURIComponent(text)}`, { method: 'GET' });
        if (!response.ok) throw new Error('Network response was not ok');
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);

        audioCache.set(cacheKey, { url: audioUrl, timestamp: Date.now() });
        return audioUrl;
    } catch (error) {
        console.error("Error generating TTS audio:", error);
        return null;
    }
};


// Speech Recognition Initialization

if ('webkitSpeechRecognition' in window) {
    speechRecognizer = new webkitSpeechRecognition();
    Object.assign(speechRecognizer, {
        continuous: true,
        interimResults: true,
        language: 'en-US',
        maxAlternatives: 3
    });

    speechRecognizer.onstart = () => {
        console.log("Speech recognition started");
        isUserSpeaking = true;
        lastUserSpeechTimestamp = Date.now();
        updateActivityIndicators();
        startStopButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h6v6h-6z"></path><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg> Stop Listening';
    };

    speechRecognizer.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                interruptAudioPlayback('final');
                processSpeechTranscript(transcript);
                isUserSpeaking = false;
                updateActivityIndicators();
                queryStartTime = Date.now();
            } else {
                interimTranscript += transcript;
                isUserSpeaking = true;
                lastUserSpeechTimestamp = Date.now();
                updateActivityIndicators();

                if (interimTranscript.length > prefetchTextQuery.length + 5) {
                    cancelPrefetchRequests(prefetchTextQuery);
                }
                prefetchTextQuery = interimTranscript;
                prefetchFirstAudioChunk(interimTranscript, voiceSelectionDropdown.value);

                if (isRequestInProgress && shouldInterruptAudioPlayback(interimTranscript)) {
                    interruptAudioPlayback('interim');
                }
            }
        }
    };

    speechRecognizer.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (isSpeechRecognitionActive) speechRecognizer.start();
    };

    speechRecognizer.onend = () => {
        isUserSpeaking = false;
        updateActivityIndicators();

        if (isSpeechRecognitionActive) speechRecognizer.start();
    };

    startStopButton.addEventListener('click', () => {
        if (isSpeechRecognitionActive) {
            speechRecognizer.stop();
            isSpeechRecognitionActive = false;
            startStopButton.innerHTML = '<svg id="microphoneIcon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg> Start Listening';
            clearInterval(webcamInterval);
            video.srcObject = null;
            lastCaption = "";
        } else {
            speechRecognizer.start();
            isSpeechRecognitionActive = true;
            startStopButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h6v6h-6z"></path><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg> Stop Listening';
            isCaptioningEnabled = true;
            startWebcam();
        }
    });
} else {
    alert('Your browser does not support the Web Speech API.');
}

setInterval(updateLatency, 100);


// Webcam Functions

async function startWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        webcamInterval = setInterval(captureAndProcessImage, WEBCAM_INTERVAL);
    } catch (error) {
        console.error("Error accessing webcam: ", error);
    }
}

async function captureAndProcessImage() {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await processWithGradio(blob);
}

async function processWithGradio(imageBlob) {
    try {
        const randomClient = clients[Math.floor(Math.random() * clients.length)];
        app = await client(randomClient);
        const handledFile = await handle_file(imageBlob);

        const result = await app.predict("/process_image", [handledFile, "More Detailed Caption"]);

        const dataString = result.data[0];
        lastCaption = dataString || lastCaption;
    } catch (error) {
        console.error("Error processing with Gradio:", error);
    }
}