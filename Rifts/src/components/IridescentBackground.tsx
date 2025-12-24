'use client';

import React, { useState, useEffect } from 'react';
import Iridescence from './Iridescence';

const IridescentBackground: React.FC = () => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="fixed inset-0 w-full h-full z-0" style={{ pointerEvents: 'none' }} />;
  }

  return (
    <div className="fixed inset-0 w-full h-full z-0" style={{ pointerEvents: 'none' }}>
      <Iridescence
        color={[0.8, 0.8, 0.8]}
        mouseReact={true}
        amplitude={0.3}
        speed={0.2}
      />
    </div>
  );
};

export default IridescentBackground;