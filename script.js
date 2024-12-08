document.addEventListener('DOMContentLoaded', () => {
    const drawBtn = document.getElementById('drawBtn');
    const numbersDiv = document.getElementById('numbers');
    const startNumInput = document.getElementById('startNum');
    const endNumInput = document.getElementById('endNum');
    const countInput = document.getElementById('count');

    drawBtn.addEventListener('click', () => {
        const startNum = parseInt(startNumInput.value);
        const endNum = parseInt(endNumInput.value);
        const count = parseInt(countInput.value);

        // 입력값 유효성 검사
        if (startNum >= endNum) {
            alert('시작 번호는 마지막 번호보다 작아야 합니다!');
            return;
        }

        if (count > (endNum - startNum + 1)) {
            alert('뽑을 숫자의 개수가 너무 많습니다!');
            return;
        }

        // 번호 추첨
        const numbers = drawNumbers(startNum, endNum, count);
        
        // 결과 표시
        displayNumbers(numbers);
    });

    function drawNumbers(start, end, count) {
        const numbers = [];
        const pool = Array.from(
            {length: end - start + 1}, 
            (_, i) => start + i
        );

        // Fisher-Yates 셔플 알고리즘
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        return pool.slice(0, count).sort((a, b) => a - b);
    }

    function displayNumbers(numbers) {
        numbersDiv.innerHTML = '';
        
        numbers.forEach((num, index) => {
            setTimeout(() => {
                const numDiv = document.createElement('div');
                numDiv.className = 'number';
                numDiv.textContent = num;
                numbersDiv.appendChild(numDiv);
            }, index * 300); // 각 번호를 0.3초 간격으로 표시
        });
    }
});
