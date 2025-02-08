const startStopButton = document.getElementById('startStopButton');
const voiceSelectionDropdown = document.getElementById('voiceSelect');
const modelSelectionDropdown = document.getElementById('modelSelect');
const noiseSuppressionCheckbox = document.getElementById('noiseSuppression');
const responseTimeDisplay = document.getElementById('responseTime');
const userActivityIndicator = document.getElementById('userIndicator');
const aiActivityIndicator = document.getElementById('aiIndicator');
const transcriptDiv = document.getElementById('transcript');

let speechRecognizer;
let activeQuery = null;
let queryStartTime = 0;
let completeTranscript = '';
let isRequestInProgress = false;
let isUserSpeaking = false;
let isSpeechRecognitionActive = false;
let requestAbortController = null;
let partialTranscript = '';
let lastUserSpeechTimestamp = null;
let prefetchTextQuery = "";
let firstResponseTextTimestamp = null;

// Configuration 
const USER_SPEECH_INTERRUPT_DELAY = 500;
const TEXT_TO_SPEECH_API_ENDPOINT = "https://api.streamelements.com/kappa/v2/speech";
const CHUNK_SIZE = 300; 

// Audio Management
let currentAudio = null;
let audioPlaybackQueue = [];
let prefetchQueue = [];

// Enhanced Prefetching and Caching
const prefetchCache = new Map(); 
const pendingPrefetchRequests = new Map();
const MAX_PREFETCH_REQUESTS = 10;
const prefetchCacheExpiration = 60000; // 1 minute

// Global Conversation History
let conversationHistory = [];

// Audio Caching
const audioCache = new Map(); 
const audioCacheExpiration = 3600000; // 1 hour

// Normalize query text
const normalizeQueryText = query => query.trim().toLowerCase().replace(/[^\w\s]/g, '');

// Generate a cache key
const generateCacheKey = (normalizedQuery, voice, history, modelName) => 
  `${normalizedQuery}-${voice}-${JSON.stringify(history)}-${modelName}`;

// Prefetch and cache the first TTS audio chunk
const prefetchFirstAudioChunk = (query, voice) => {
  const normalizedQuery = normalizeQueryText(query);
  const cacheKey = generateCacheKey(normalizedQuery, voice, conversationHistory, modelSelectionDropdown.value);

  if (pendingPrefetchRequests.has(cacheKey) || prefetchCache.has(cacheKey)) return; 

  prefetchQueue.push({ query:query.trim(), voice, cacheKey });
  processPrefetchQueue();
};

// Process the prefetch queue
const processPrefetchQueue = async () => {
  while (prefetchQueue.length > 0 && pendingPrefetchRequests.size < MAX_PREFETCH_REQUESTS) {
    const { query, voice, cacheKey } = prefetchQueue.shift();
    const abortController = new AbortController();
    pendingPrefetchRequests.set(cacheKey, abortController);

    const userSambanovaKey = document.getElementById('apiKey').value.trim() !== '' ? document.getElementById('apiKey').value : 'none';

    const url = '/stream_text';
    const requestBody = {
        query: query,
        history: JSON.stringify(conversationHistory),
        model: modelSelectionDropdown.value,
        api_key: userSambanovaKey
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: abortController.signal
    });

      if (!response.ok) throw new Error('Network response was not ok');

      const firstAudioUrl = await handleStreamingResponseForPrefetch(response.body, voice, abortController.signal);

      if (firstAudioUrl) prefetchCache.set(cacheKey, { url: firstAudioUrl, timestamp: Date.now() });

    } catch (error) {
      if (error.name !== 'AbortError') console.error("Error prefetching audio:", error);
    } finally {
      pendingPrefetchRequests.delete(cacheKey);
      processPrefetchQueue();
    }
  }
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
            const audioUrl = await generateTextToSpeechAudio(textContent, voice);
            return audioUrl; 
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

// Play audio from the queue
const playNextAudio = async () => {
  if (audioPlaybackQueue.length > 0) {
    const audioData = audioPlaybackQueue.shift();
    const audio = new Audio(audioData.url);
    updateActivityIndicators(); 

    // Pause speech recognition if it's active
    if (isSpeechRecognitionActive) {
      speechRecognizer.stop();
      isSpeechRecognitionActive = false;
      startStopButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
        Interrupt AI
      `;
    }

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

    // Resume speech recognition if it was paused with a delay
    setTimeout(() => {
      if (!isSpeechRecognitionActive) { 
        speechRecognizer.start();
        isSpeechRecognitionActive = true;
        startStopButton.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 9h6v6h-6z"></path>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg> 
          Stop Listening
        `;
      }
    }, 100);
  }
};

// Generate Text-to-Speech audio with caching
const generateTextToSpeechAudio = async (text, voice) => {
  const normalizedText = normalizeQueryText(text);
  const cacheKey = `${normalizedText}-${voice}`;

  if (audioCache.has(cacheKey)) {
    const cachedData = audioCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < audioCacheExpiration) {
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

// Send a query to the AI
const sendQueryToAI = async (query) => {
    console.log("Sending query to AI:", query);
    isRequestInProgress = true;
    updateActivityIndicators(); 
    queryStartTime = Date.now();
    firstResponseTextTimestamp = null;

    const normalizedQuery = normalizeQueryText(query);
    const cacheKey = generateCacheKey(normalizedQuery, modelSelectionDropdown.value, conversationHistory, modelSelectionDropdown.value);

    if (prefetchCache.has(cacheKey)) {
        const cachedData = prefetchCache.get(cacheKey);
        if (Date.now() - cachedData.timestamp < prefetchCacheExpiration) {
            const prefetchedAudioUrl = cachedData.url;
            audioPlaybackQueue.push({ url: prefetchedAudioUrl, isPrefetched: true });
            playNextAudio();
        } else {
            prefetchCache.delete(cacheKey);
        }
    }

    requestAbortController = new AbortController();

    const userSambanovaKey = document.getElementById('apiKey').value.trim() !== '' ? document.getElementById('apiKey').value : 'none';

    const url = '/stream_text';
    const requestBody = {
        query: query,
        history: JSON.stringify(conversationHistory),
        model: modelSelectionDropdown.value,
        api_key: userSambanovaKey
    };
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Accept': 'text/event-stream',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: requestAbortController.signal
        });

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
        await handleStreamingResponse(response.body, voiceSelectionDropdown.value, requestAbortController.signal);
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Error sending query to AI:", error);
        }
    } finally {
        isRequestInProgress = false;
        updateActivityIndicators(); 
    }
};

// Handle the streaming audio response
const handleStreamingResponse = async (responseStream, voice, abortSignal) => {
  const reader = responseStream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let initialChunksSent = 0;
  let fullResponseText = "";
  let textChunk = "";
  let sentText = ""; 

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

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.startsWith('data: ')) {
          const textContent = line.substring(6).trim();
          if (textContent) {
            if (!firstResponseTextTimestamp) firstResponseTextTimestamp = Date.now();

            fullResponseText += textContent + " ";
            textChunk += textContent + " ";
            transcriptDiv.textContent = fullResponseText; // Update transcriptDiv

            if (initialChunksSent < 2) {
              const audioUrl = await generateTextToSpeechAudio(textContent, voice);
              if (audioUrl) {
                audioPlaybackQueue.push({ url: audioUrl, isPrefetched: false });
                if (!currentAudio) playNextAudio();
              }
              sentText += textContent + " "; 
              initialChunksSent++;
            } else {
              let unsentTextChunk = textChunk.replace(sentText, '').trim();

              if (unsentTextChunk.length >= CHUNK_SIZE) {
                const audioUrl = await generateTextToSpeechAudio(unsentTextChunk, voice);
                if (audioUrl) {
                  audioPlaybackQueue.push({ url: audioUrl, isPrefetched: false });
                  if (!currentAudio) playNextAudio();
                }
                textChunk = ""; 
              }
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

    let unsentTextChunk = textChunk.replace(sentText, '').trim();
    if (unsentTextChunk !== "") {
      const audioUrl = await generateTextToSpeechAudio(unsentTextChunk, voice);
      if (audioUrl) {
        audioPlaybackQueue.push({ url: audioUrl, isPrefetched: false });
        if (!currentAudio) playNextAudio();
      }
    }

    if (fullResponseText !== '') {
      addToConversationHistory('assistant', fullResponseText);
      fullResponseText = ''; // Clear fullResponseText for the next response
    }
  }
};

// Update activity indicators
const updateActivityIndicators = (state = null) => {
  userActivityIndicator.textContent = isUserSpeaking ? "User: Speaking" : "User: Idle";
  userActivityIndicator.className = isUserSpeaking 
    ? "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-blue-400 to-blue-600 hover:bg-gradient-to-r from-blue-500 to-blue-700" 
    : "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-gray-300 to-gray-400 dark:from-gray-700 dark:to-gray-800 hover:bg-gradient-to-r from-gray-400 to-gray-500"; // Tailwind classes

  if (isRequestInProgress && !currentAudio) {
    aiActivityIndicator.textContent = "AI: Processing...";
    aiActivityIndicator.className = "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-purple-400 to-purple-600 hover:bg-gradient-to-r from-purple-500 to-purple-700"; // Tailwind class for thinking
  } else if (currentAudio && !isUserSpeaking) {
    aiActivityIndicator.textContent = state || "AI: Speaking";
    aiActivityIndicator.className = "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-green-400 to-green-600 hover:bg-gradient-to-r from-green-500 to-green-700"; // Tailwind class for speaking
  } else if (isUserSpeaking) {
    aiActivityIndicator.textContent = "AI: Listening";
    aiActivityIndicator.className = "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-yellow-400 to-yellow-600 hover:bg-gradient-to-r from-yellow-500 to-yellow-700"; // Tailwind class for listening
  } else {
    aiActivityIndicator.textContent = "AI: Idle";
    aiActivityIndicator.className = "indicator rounded-full px-4 py-2 text-white flex items-center transition-colors duration-300 bg-gradient-to-r from-gray-300 to-gray-400 dark:from-gray-700 dark:to-gray-800 hover:bg-gradient-to-r from-gray-400 to-gray-500"; // Tailwind classes
  }
};

// Initialize speech recognition
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
    completeTranscript = '';
    isUserSpeaking = true;
    lastUserSpeechTimestamp = Date.now();
    updateActivityIndicators(); 
    startStopButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 9h6v6h-6z"></path>
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <line x1="12" y1="19" x2="12" y2="23"></line>
        <line x1="8" y1="23" x2="16" y2="23"></line>
      </svg> 
      Stop Listening
    `; 
  };

  speechRecognizer.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        completeTranscript += transcript;
        interruptAudioPlayback('final');
        processSpeechTranscript(completeTranscript);
        completeTranscript = '';
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

    if (!isRequestInProgress && completeTranscript !== '') {
      processSpeechTranscript(completeTranscript);
      completeTranscript = '';
    }

    if (isSpeechRecognitionActive) speechRecognizer.start();
  };

  startStopButton.addEventListener('click', () => {
    if (isSpeechRecognitionActive && !isRequestInProgress) { // Stop Listening
      speechRecognizer.stop();
      isSpeechRecognitionActive = false;
      startStopButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
        Start Listening
      `; 
    } else if (isSpeechRecognitionActive && isRequestInProgress || currentAudio) { // Interrupt AI
      interruptAudioPlayback('button interrupt');
      speechRecognizer.start();
      isSpeechRecognitionActive = true; // Keep recognition active
      startStopButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
        Interrupt AI
      `; // Replace with your SVG
    } else { // Start Listening
      speechRecognizer.start();
      isSpeechRecognitionActive = true;
      startStopButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 9h6v6h-6z"></path>
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg> 
        Stop Listening
      `; // Replace with your SVG
    }
  });
} else {
  alert('Your browser does not support the Web Speech API.');
}

// Add to conversation history
const addToConversationHistory = (role, content) => {
  if (conversationHistory.length > 0 &&
    conversationHistory[conversationHistory.length - 1].role === 'assistant' &&
    conversationHistory[conversationHistory.length - 1].content === "") {
    conversationHistory.pop();
  }

  conversationHistory.push({ role, content });

  if (conversationHistory.length > 6) conversationHistory.splice(0, 2);
};

// Process the final speech transcript
const processSpeechTranscript = (transcript) => {
  const trimmedTranscript = transcript.trimStart();
  if (trimmedTranscript !== '' && !isRequestInProgress) {
    activeQuery = trimmedTranscript;
    sendQueryToAI(activeQuery);
    addToConversationHistory('user', activeQuery);
    transcriptDiv.textContent = ''; 
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

  prefetchCache.clear();
  prefetchQueue.length = 0; 
  updateActivityIndicators();
};

// Cancel pending prefetch requests
const cancelPrefetchRequests = (query) => {
  const normalizedQuery = normalizeQueryText(query);

  for (const [cacheKey, abortController] of pendingPrefetchRequests) {
    if (cacheKey.startsWith(normalizedQuery)) {
      abortController.abort();
      pendingPrefetchRequests.delete(cacheKey);
    }
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

setInterval(updateLatency, 200); 
