// Add Buy RIFTS button to website landing page
(function() {
    window.addEventListener('load', function() {
        // Wait for page to fully load
        setTimeout(function() {
            // Create Buy button
            const buyButton = document.createElement('a');
            buyButton.href = 'https://jup.ag/swap/SOL-HjBMk5rABYdAvukYRvrScBnP9KnN9nLdKSbN2QPppump';
            buyButton.target = '_blank';
            buyButton.rel = 'noopener noreferrer';
            buyButton.textContent = 'BUY RIFTS';
            buyButton.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 32px;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                text-decoration: none;
                border-radius: 8px;
                font-family: 'Poppins', sans-serif;
                font-weight: 600;
                font-size: 16px;
                box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
                transition: all 0.3s ease;
                z-index: 999999;
                cursor: pointer;
            `;

            // Hover effect
            buyButton.addEventListener('mouseenter', function() {
                buyButton.style.transform = 'translateY(-2px)';
                buyButton.style.boxShadow = '0 6px 20px rgba(16, 185, 129, 0.6)';
            });

            buyButton.addEventListener('mouseleave', function() {
                buyButton.style.transform = 'translateY(0)';
                buyButton.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.4)';
            });

            // Add to page
            document.body.appendChild(buyButton);
        }, 1000);
    });
})();
