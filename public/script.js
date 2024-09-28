let recognition;
let isRecognizing = false;
let lastAudioPath = '';
let currentAnswer = null;
let isPlayingFeedback = false;
let isProcessingRound = false;
let isGameRunning = false;

document.getElementById('startGameBtn').addEventListener('click', () => {
    if (isGameRunning) {
        endGame();
    } else {
        startGameRound();
    }
});

async function startGameRound() {
    const audioPlayer = document.getElementById('audioPlayer');
    const startButton = document.getElementById('startGameBtn');

    if (isPlayingFeedback || isProcessingRound) {
        console.log('Waiting for feedback or round processing...');
        return;
    }

    try {
        isProcessingRound = true;
        isGameRunning = true;
        startButton.textContent = 'End Game';

        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);

        const response = await fetch('/start-game');
        if (!response.ok) throw new Error('Failed to start the game');

        const { question, answer, audioPath } = await response.json();
        console.log('Received question:', question);
        console.log('Received audio path:', audioPath);

        currentAnswer = answer;
        lastAudioPath = audioPath;

        audioPlayer.src = audioPath;
        console.log('Playing question audio from:', audioPlayer.src);
        await playAudio(audioPlayer);

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);

        isProcessingRound = false;
    } catch (error) {
        console.error('Error during the game:', error);
        alert('An error occurred, please try again.');
    }
}

function handleKeyDown(event) {
    if (event.code === 'Space' && !isRecognizing) {
        startSpeechRecognition();
    } else if (event.code === 'KeyR') {
        repeatLastAudio();
    }
}

function handleKeyUp(event) {
    if (event.code === 'Space' && isRecognizing) {
        stopSpeechRecognition();
    }
}

function startSpeechRecognition() {
    if (isRecognizing) return;

    recognition = new webkitSpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.start();
    isRecognizing = true;

    console.log('Speech recognition started...');

    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        console.log('User said:', transcript);
        recognition.userAnswer = transcript;
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
        console.log('Speech recognition ended');
        isRecognizing = false;
    };
}

async function stopSpeechRecognition() {
    if (recognition) {
        recognition.stop();
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const userAnswer = recognition.userAnswer || '';
    if (!userAnswer.trim()) {
        console.error('No valid user answer detected.');
        await playNoInputDetectedAudio();
        retryRound();
        return;
    }

    console.log('Submitting userAnswer:', userAnswer);
    console.log('Submitting correctAnswer:', currentAnswer);

    try {
        const resultResponse = await fetch('/submit-answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audioBytes: userAnswer.trim(),
                correctAnswer: currentAnswer
            })
        });

        if (!resultResponse.ok) throw new Error('Failed to submit answer');
        const { feedback, feedbackAudioPath, accuracy, totalGamesPlayed, correctAnswers } = await resultResponse.json();

        console.log(`Accuracy: ${accuracy}%`);
        console.log(`Total Games Played: ${totalGamesPlayed}`);
        console.log(`Correct Answers: ${correctAnswers}`);

        isPlayingFeedback = true;
        lastAudioPath = feedbackAudioPath;
        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = feedbackAudioPath;
        console.log('Playing feedback audio from:', feedbackAudioPath);

        await playAudio(audioPlayer);
        isPlayingFeedback = false;

        if (isGameRunning) {
            setTimeout(startGameRound, 1000);
        }
    } catch (error) {
        console.error('Error submitting answer:', error);
    }
}

function retryRound() {
    console.log('Retrying round. Waiting for valid input...');
    const audioPlayer = document.getElementById('audioPlayer');
    audioPlayer.src = lastAudioPath;
    playAudio(audioPlayer);

    document.addEventListener('keydown', handleKeyDown);
}

async function repeatLastAudio() {
    if (!lastAudioPath) return;

    const response = await fetch('/repeat-audio');
    if (!response.ok) {
        console.error('Failed to repeat audio');
        return;
    }

    const { audioPath } = await response.json();
    const audioPlayer = document.getElementById('audioPlayer');
    audioPlayer.src = audioPath;
    await playAudio(audioPlayer);
}

async function playNoInputDetectedAudio() {
    try {
        const response = await fetch('/no-input-audio');
        if (!response.ok) throw new Error('Failed to get no input audio');

        const { noInputAudioPath } = await response.json();
        const audioPlayer = document.getElementById('audioPlayer');
        audioPlayer.src = noInputAudioPath;
        await playAudio(audioPlayer);
    } catch (error) {
        console.error('Error playing "I didn\'t get that" audio:', error);
    }
}

function playAudio(audioElement) {
    return new Promise((resolve, reject) => {
        audioElement.onended = resolve;
        audioElement.onerror = (error) => {
            console.error('Audio playback error:', error);
            reject(error);
        };
        audioElement.play().catch(reject);
    });
}

function endGame() {
    const startButton = document.getElementById('startGameBtn');
    isGameRunning = false;
    startButton.textContent = 'Start Game';

    fetch('/end-game')
        .then(response => response.json())
        .then(data => {
            console.log('Game ended. Results:', data);
            alert(`Game over! Total games played: ${data.totalGamesPlayed}, Correct answers: ${data.correctAnswers}, Accuracy: ${data.accuracy}%`);
        })
        .catch(error => console.error('Error ending the game:', error));
}